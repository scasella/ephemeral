# Edit workspace files

Open **Files** in a running machine to browse the repository, open a text file and edit it without a terminal command. Select a folder to enter it; use **Up** to return to its parent. Choose **New file** to create a text file in an existing folder.

Choose **Save file**, or press **Ctrl+S** / **Cmd+S** in the editor, to write your draft to the machine. The editor issues no terminal commands, commits or pushes, and saving does not extend the session. Running development servers and file watchers can react to saved changes. Review **Changes**, then commit and push intentional work before the machine expires. File saves are separate from durable **Notes**.

## Drafts and conflicts

Drafts stay in this page's memory when you switch workspace tabs, views or machines. The editor does not put file contents in browser storage or the control-plane database. Reloading or closing the page can lose unsaved drafts; the browser may show a leave-page warning. The editor has a finite draft limit and will not silently evict an unsaved draft.

If Codex or another tool changes a file after you open it, saving reports a conflict and preserves your draft. Read the current file and reconcile your edits before saving again. There is no force-overwrite action. Version checks detect observed changes; they cannot lock out unrelated processes writing in the machine. Avoid editing the same file in Codex and the browser at the same time.

If the current file has been deleted, reading it preserves your draft and reports its absence for review. Choose **Recreate deleted file** to prepare creation with your draft, then choose **Save file** separately. A file that appears at the same path before saving blocks creation and preserves your draft for another review.

If a save response is lost, the write may already have happened. Keep the draft and check the current file before retrying. Creating a file never intentionally overwrites an existing file.

## Supported files and limits

- UTF-8 text files up to **128 KiB**; binary, invalid UTF-8 and unsupported control characters are unavailable.
- Directory listings show up to **200 entries** and identify when the listing is incomplete.
- Paths are relative to the repository workspace. Git metadata, traversal paths, symbolic links, hard-linked files and special files cannot be edited.
- Existing executable permissions are retained. Parent folders must already exist; creating folders, deleting files and renaming files are outside this editor's scope.
- Existing uniform LF, CRLF or CR line endings are preserved. New files use LF. Mixed line endings show a notice and normalize to LF when edited.
- Files require a running, unexpired machine and current repository access. Ending the machine makes its file editor unavailable.

File operations have a 10-second guest command timeout and a 12-second transport deadline. The controller counts UTF-8 output bytes as they arrive and stops receiving when stdout exceeds 1,000,000 bytes or stderr exceeds 64 KiB, including output from shell startup files. The SDK can retain the chunk that crosses a limit before the callback stops the stream. Errors shown in the editor never include guest output. An interrupted save can still have completed; check the current file before retrying.

This is a lightweight text editor, without language servers, syntax highlighting or an integrated Git commit action. Applications opened through **Preview** keep their own controls.

## Local simulation

`npm run local` supplies a small, clearly labeled sample workspace. You can try browsing, editing and creating files without accounts or E2B compute. Sample files live only in the controller process's memory, are isolated per simulated machine and disappear when that machine stops or the controller restarts. They are not files in your local checkout and are not sent to GitHub or Codex.
