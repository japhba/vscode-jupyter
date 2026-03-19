# Remote State Checkpointing for vscode-jupyter

## Goal

Serialize the full notebook editor state (scroll position, selected cell, collapsed cells, widget state including live widget reconnection) to a file on the remote filesystem periodically. On SSH reconnect, restore from that checkpoint. This mirrors Jupyter Lab's server-side workspace storage.

## Architecture

Three new components in the extension host (which runs on the remote machine):

1. **`StateCheckpointWriter`** — Periodically (every 5s) serializes notebook state to a `.jstate` file on the remote filesystem
2. **`StateCheckpointReader`** — On extension activation, checks for existing `.jstate` files and orchestrates restore
3. **`WidgetCommRestorer`** — After kernel reattach, re-establishes live widget comm channels

Key insight: when SSH drops and reconnects, VS Code spawns a **new extension host** on the remote side. The old one is dead. So "reconnect detection" = finding a recent `.jstate` file on activation.

## Checkpoint File Format

Location: `<dir>/.<notebook>.ipynb.jstate` (hidden, sibling to notebook)

```json
{
  "version": 1,
  "timestamp": 1711000000000,
  "notebookUri": "/home/user/analysis.ipynb",
  "kernel": { "id": "...", "sessionId": "...", "kernelSpecName": "python3" },
  "editor": {
    "activeCellIndex": 3,
    "visibleRangeStart": 2,
    "visibleRangeEnd": 8,
    "collapsedCells": [0, 5]
  },
  "widgets": {
    "modelState": {
      "model-id-1": {
        "model_name": "IntSliderModel",
        "model_module": "@jupyter-widgets/controls",
        "state": { "value": 42 },
        "comm_id": "comm-id-1"
      }
    }
  }
}
```

## Files to Create

| File | Role |
|------|------|
| `src/kernels/checkpoint/types.ts` | TypeScript interfaces for checkpoint data |
| `src/kernels/checkpoint/stateCheckpointWriter.ts` | Timer-based state serialization |
| `src/kernels/checkpoint/stateCheckpointReader.ts` | Activation-time restore orchestration |
| `src/kernels/checkpoint/widgetCommRestorer.ts` | Widget comm re-establishment |

## Files to Modify

| File | Change |
|------|--------|
| `src/kernels/kernelProvider.base.ts` | Add `reconnectToExistingKernel()` method |
| `src/kernels/jupyter/session/jupyterKernelSessionFactory.ts` | Support `SessionManager.connectTo` for reattaching to live sessions |
| `src/notebooks/controllers/ipywidgets/message/ipyWidgetMessageDispatcher.ts` | Expose `getWidgetModelState()` and comm target info |
| `src/webviews/extension-side/ipywidgets/rendererComms.ts` | Expose `widgetOutputsPerNotebook` via public getter |
| `src/notebooks/controllers/ipywidgets/notebookIPyWidgetCoordinator.ts` | Re-attach webview comms and re-init `CommonMessageCoordinator` on restore |
| `src/kernels/serviceRegistry.node.ts` | Register new checkpoint services |

## Restore Flow

1. **Detect**: On activation, scan open notebooks for sibling `.jstate` files (< 5 min old)
2. **Reattach kernel**: Use `SessionManager.connectTo` with the saved kernel/session ID
3. **Restore editor**: Set selections (active cell), `revealRange` (scroll), restore collapsed cells
4. **Restore widgets**: Send `comm_info_request` to kernel -> cross-reference with checkpoint -> `comm_open` for each live widget -> kernel responds with `comm_msg` containing current state -> existing `IPyWidgetMessageDispatcher` pipeline rebuilds widgets
5. **Cleanup**: Delete `.jstate` after successful restore, on kernel shutdown, or on notebook close

## Edge Cases

- **Kernel died**: `connectTo` fails -> delete checkpoint, notify user
- **Notebook modified externally**: Store content hash in checkpoint, skip editor restore on mismatch but still attempt kernel reattach
- **Widget state drift**: Kernel is authoritative — after comm re-establishment it syncs current state
- **Large widget buffers**: Only store model IDs in checkpoint, request full state from kernel on restore
- **Multiple VS Code windows**: Include extension host PID in checkpoint filename to avoid races
- **Output scroll positions**: Not accessible from extension host API (V2: requires renderer-side messages)
- **Security**: Checkpoint contains kernel IDs — use 0600 file permissions

## Settings

- `jupyter.checkpoint.enabled` (default: `true` for remote, `false` for local)
- `jupyter.checkpoint.intervalMs` (default: `5000`)
- `jupyter.checkpoint.staleThresholdMs` (default: `300000`)

## Implementation Order

1. Checkpoint types (`types.ts`)
2. Writer — kernel identity + editor state, no widgets yet
3. Reader — kernel reattach via `SessionManager.connectTo` + editor state restore
4. Configuration settings
5. Widget comm restorer
6. Modify `IPyWidgetMessageDispatcher` and `IPyWidgetRendererComms` to expose state
7. Integration tests
