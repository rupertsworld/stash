# Stash TODO

Future improvements and deferred decisions.

## Orphan Cleanup

Orphan file docs (deleted files) are currently kept on disk for potential recovery. Implement automatic cleanup:

- Delete orphan `.automerge` files older than 30 days
- Run cleanup at start of sync or as separate `stash gc` command
- Consider: should cleanup be configurable? (retention period, disable)

## Future Considerations

Items from the spec's "Future Considerations" that need more thought:

- Real-time sync providers (WebSocket-based)
- Editor plugins for direct Automerge integration
- Conflict surfacing UI
- File watching for local edits (with diff-based patching)
- Binary file support
- File size limits
- Permissions / read-only sharing
