// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable, optional } from 'inversify';
import { Uri } from 'vscode';
import { IKernelSession, IKernelSessionFactory, IJupyterConnection, isLocalConnection, KernelSessionCreationOptions } from '../types';
import { IRawKernelSessionFactory, IRawNotebookSupportedService } from '../raw/types';
import { JupyterKernelSessionFactory } from '../jupyter/session/jupyterKernelSessionFactory';
import { IAsyncDisposableRegistry, IConfigurationService } from '../../platform/common/types';
import { IPersistentJupyterServer, PersistentServerInfo } from '../checkpoint/persistentJupyterServer';
import { IInterpreterService } from '../../platform/interpreter/contracts';
import { logger } from '../../platform/logging';
import { JupyterLabHelper } from '../jupyter/session/jupyterLabHelper';
import { JupyterSessionWrapper } from '../jupyter/session/jupyterSession';
import { IJupyterKernelService } from '../jupyter/types';
import { JVSC_EXTENSION_ID } from '../../platform/common/constants';
import { getNameOfKernelConnection } from '../helpers';
import { generateUuid } from '../../platform/common/uuid';
import { raceCancellationError } from '../../platform/common/cancellation';
import { waitForIdleOnSession } from '../common/helpers';
import { noop } from '../../platform/common/utils/misc';
import { disposeAsync } from '../../platform/common/utils';
import type { Session } from '@jupyterlab/services';
import * as path from '../../platform/vscode-path/resources';
import { DataScience } from '../../platform/common/utils/localize';

/**
 * Generic class for connecting to a server. Probably could be renamed as it doesn't provide notebooks, but rather connections.
 */
@injectable()
export class KernelSessionFactory implements IKernelSessionFactory {
    constructor(
        @inject(IRawNotebookSupportedService)
        private readonly rawKernelSupported: IRawNotebookSupportedService,

        @inject(IRawKernelSessionFactory)
        @optional()
        private readonly newRawKernelSessionFactory: IRawKernelSessionFactory | undefined,
        @inject(JupyterKernelSessionFactory)
        private readonly newJupyterSessionFactory: IKernelSessionFactory,
        @inject(IConfigurationService)
        private readonly configService: IConfigurationService,
        @inject(IPersistentJupyterServer)
        @optional()
        private readonly persistentServer: IPersistentJupyterServer | undefined,
        @inject(IInterpreterService)
        private readonly interpreterService: IInterpreterService,
        @inject(IJupyterKernelService)
        @optional()
        private readonly kernelService: IJupyterKernelService | undefined,
        @inject(IAsyncDisposableRegistry)
        private readonly asyncDisposables: IAsyncDisposableRegistry
    ) {}

    public async create(options: KernelSessionCreationOptions): Promise<IKernelSession> {
        const kernelConnection = options.kernelConnection;

        // When persistent server is enabled, route local kernels through a detached Jupyter server
        // so that kernels survive extension host restarts (SSH reconnects).
        if (
            isLocalConnection(kernelConnection) &&
            this.persistentServer &&
            this.configService.getSettings(options.resource).persistentServer
        ) {
            return this.createViaPersistentServer(options);
        }

        if (
            this.rawKernelSupported.isSupported &&
            isLocalConnection(kernelConnection) &&
            this.newRawKernelSessionFactory
        ) {
            return this.newRawKernelSessionFactory.create({ ...options, kernelConnection: kernelConnection });
        } else {
            return this.newJupyterSessionFactory.create(options);
        }
    }

    private async createViaPersistentServer(options: KernelSessionCreationOptions): Promise<IKernelSession> {
        // Resolve the Python path: try the kernel connection's interpreter, then the kernel spec's
        // executable (argv[0]), then the active interpreter, then 'python3'.
        const conn = options.kernelConnection;
        const pythonPath = conn.interpreter?.uri.fsPath
            || ('kernelSpec' in conn && conn.kernelSpec?.executable) || undefined
            || (await this.interpreterService.getActiveInterpreter(options.resource))?.uri.fsPath
            || 'python3';
        logger.info(`Persistent server will use Python: ${pythonPath}`);
        const rootDir = options.resource
            ? path.dirname(options.resource).fsPath
            : (await import('os')).homedir();

        const serverInfo = await this.persistentServer!.getOrStartServer(pythonPath, rootDir);
        logger.info(`Using persistent Jupyter server at ${serverInfo.baseUrl} for local kernel`);

        const connection = this.buildConnection(serverInfo, options.resource);
        const idleTimeout = this.configService.getSettings(options.resource).jupyterLaunchTimeout;

        const sessionManager = JupyterLabHelper.create(connection.settings);
        this.asyncDisposables.push({ dispose: () => disposeAsync(sessionManager) });

        const kernelName = getNameOfKernelConnection(options.kernelConnection) ?? sessionManager.kernelSpecManager?.specs?.default ?? '';
        const fileExtension = options.resource ? path.extname(options.resource) : '';
        const baseName = options.resource ? path.basename(options.resource, fileExtension) : 'notebook';
        const sessionName = `${baseName}-${generateUuid()}${fileExtension}`;

        const sessionOptions: Session.ISessionOptions = {
            path: `${options.resource ? path.basename(options.resource, '.ipynb') : DataScience.defaultNotebookName}-${generateUuid()}.ipynb`,
            kernel: { name: kernelName },
            name: sessionName,
            type: (options.resource?.path || '').toLowerCase().endsWith('.ipynb') ? 'notebook' : 'console'
        };

        const session = await raceCancellationError(
            options.token,
            sessionManager.sessionManager.startNew(sessionOptions, {
                kernelConnectionOptions: { handleComms: true }
            })
        );

        await waitForIdleOnSession(options.kernelConnection, options.resource, session, idleTimeout, options.token).catch(noop);

        const wrapperSession = new JupyterSessionWrapper(
            session,
            options.resource,
            options.kernelConnection,
            this.kernelService,
            options.creator
        );

        const disposed = session.disposed;
        const onDidDisposeSession = () => {
            sessionManager.dispose();
            disposed.disconnect(onDidDisposeSession);
        };
        this.asyncDisposables.push({
            dispose: () => wrapperSession.shutdown().finally(() => wrapperSession.dispose())
        });
        session.disposed.connect(onDidDisposeSession);
        const disposable = wrapperSession.onDidDispose(onDidDisposeSession);
        this.asyncDisposables.push(disposable);

        return wrapperSession;
    }

    private buildConnection(serverInfo: PersistentServerInfo, resource: Uri | undefined): IJupyterConnection {
        const { ServerConnection } = require('@jupyterlab/services');
        const settings = ServerConnection.makeSettings({
            baseUrl: serverInfo.baseUrl,
            appUrl: '',
            wsUrl: serverInfo.baseUrl.replace('http', 'ws'),
            token: serverInfo.token,
            appendToken: true
        });

        return {
            baseUrl: serverInfo.baseUrl,
            token: serverInfo.token,
            providerId: '_builtin.persistentCheckpointServer',
            serverProviderHandle: { extensionId: JVSC_EXTENSION_ID, id: '_builtin.persistentCheckpointServer', handle: 'persistent' },
            hostName: '127.0.0.1',
            displayName: 'Persistent Jupyter Server (checkpoint)',
            rootDirectory: Uri.file(serverInfo.rootDirectory),
            settings,
            dispose: noop
        };
    }
}
