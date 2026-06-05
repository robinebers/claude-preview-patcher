# Claude Preview Patcher

Claude Code Desktop is a great app. Honestly good.

There's only one problem. You can't build any apps that use external services, like [Clerk](https://clerk.com) or [AuthKit](https://www.authkit.com) by [WorkOS](https://workos.com).

This tool fixes that. But note, it might be against terms. It might get you banned. Yadda yadda yadda. Don't blame me.

## What it does

It lets sign-in pages from services like Clerk and WorkOS open inside Claude's
Preview, which the app normally blocks.

## How it works

It makes a separate copy of Claude — **Claude (Patched)** — with that one change,
and leaves your real Claude completely untouched. The two sit side by side in your
Applications folder, so you can use either one.

## How to use it

You'll need a Mac and [Node.js](https://nodejs.org/) (version 20 or newer).

1. Quit Claude.
2. Open Terminal (press **⌘ + Space**, type **Terminal**, press Return).
3. Paste this and press Return:
   ```sh
   npx github:robinebers/claude-preview-patcher
   ```
4. Type `y` to confirm. Then open **Claude (Patched)** from your Applications folder.

To undo it, just drag **Claude (Patched)** to the Trash.
