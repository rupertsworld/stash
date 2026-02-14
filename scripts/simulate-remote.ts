#!/usr/bin/env npx tsx
/**
 * Simulate another computer adding a file to a stash.
 * This directly uses the GitHub API to add a file, bypassing local stash.
 *
 * Usage: npx tsx scripts/simulate-remote.ts <stash-name> <filepath> <content>
 * Example: npx tsx scripts/simulate-remote.ts test-stash hello.md "Hello from remote!"
 */

import * as Automerge from "@automerge/automerge";
import { Octokit } from "octokit";
import { ulid } from "ulid";
import { getGitHubToken, DEFAULT_STASH_DIR } from "../src/core/config.js";
import { StashManager } from "../src/core/manager.js";
import type { StructureDoc } from "../src/core/structure.js";
import type { FileDoc } from "../src/core/file.js";

async function main() {
  const [, , stashName, filePath, content] = process.argv;

  if (!stashName || !filePath || content === undefined) {
    console.error(
      "Usage: npx tsx scripts/simulate-remote.ts <stash-name> <filepath> <content>",
    );
    console.error(
      'Example: npx tsx scripts/simulate-remote.ts test hello.md "Hello from remote!"',
    );
    process.exit(1);
  }

  // Load local stash to get repo info
  const manager = await StashManager.load();
  const stash = manager.get(stashName);
  if (!stash) {
    console.error(`Stash not found: ${stashName}`);
    process.exit(1);
  }

  const meta = stash.getMeta();
  if (!meta.key || !meta.key.startsWith("github:")) {
    console.error("Stash is not synced to GitHub");
    process.exit(1);
  }

  const token = await getGitHubToken();
  if (!token) {
    console.error("No GitHub token found");
    process.exit(1);
  }

  const [, repoPath] = meta.key.split(":");
  const [owner, repo] = repoPath.split("/");

  console.log(`Simulating remote edit on ${owner}/${repo}...`);
  console.log(`Adding file: ${filePath}`);

  const octokit = new Octokit({ auth: token });

  // Fetch current structure doc from GitHub
  let structureDoc: Automerge.Doc<StructureDoc>;
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: ".stash/structure.automerge",
      ref: "main",
    });
    if ("content" in data && data.content) {
      const structureData = Uint8Array.from(Buffer.from(data.content, "base64"));
      structureDoc = Automerge.load<StructureDoc>(structureData);
    } else {
      throw new Error("No content");
    }
  } catch (err) {
    console.error("Failed to fetch structure doc:", (err as Error).message);
    process.exit(1);
  }

  // Create a new file doc with a unique actor ID
  const actorId = ulid();
  const hexActorId = Buffer.from(actorId).toString("hex").padEnd(64, "0");
  const docId = ulid();

  // Create file doc
  let fileDoc = Automerge.init<FileDoc>({ actor: hexActorId as any });
  fileDoc = Automerge.change(fileDoc, (doc) => {
    doc.content = new Automerge.Text(content);
  });

  // Update structure doc
  structureDoc = Automerge.change(structureDoc, (doc) => {
    doc.files[filePath] = {
      docId,
      created: Date.now(),
    };
  });

  // Get current commit SHA
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: "heads/main",
  });
  const parentSha = ref.object.sha;

  const { data: commit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: parentSha,
  });
  const baseTreeSha = commit.tree.sha;

  // Create blobs
  const structureBlob = await octokit.rest.git.createBlob({
    owner,
    repo,
    content: Buffer.from(Automerge.save(structureDoc)).toString("base64"),
    encoding: "base64",
  });

  const fileBlob = await octokit.rest.git.createBlob({
    owner,
    repo,
    content: Buffer.from(Automerge.save(fileDoc)).toString("base64"),
    encoding: "base64",
  });

  // Create tree
  const { data: tree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: [
      {
        path: ".stash/structure.automerge",
        mode: "100644",
        type: "blob",
        sha: structureBlob.data.sha,
      },
      {
        path: `.stash/docs/${docId}.automerge`,
        mode: "100644",
        type: "blob",
        sha: fileBlob.data.sha,
      },
      {
        path: filePath,
        mode: "100644",
        type: "blob",
        content,
      },
    ],
  });

  // Create commit
  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: `Simulated remote: add ${filePath}`,
    tree: tree.sha,
    parents: [parentSha],
  });

  // Update ref
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: "heads/main",
    sha: newCommit.sha,
  });

  console.log(`Done! Committed ${newCommit.sha.slice(0, 7)}`);
  console.log(`\nTo see the change locally, run: stash sync ${stashName}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
