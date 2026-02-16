import { Option } from "commander";

export const pathOption = new Option(
  "--path <path>",
  "where to create the stash (default: ~/.stash/<name>)",
);

export const descriptionOption = new Option(
  "--description <desc>",
  "description to help models understand the stash",
);

export const forceOption = new Option("--force", "skip confirmation prompts");
