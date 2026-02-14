import { setGitHubToken } from "../../core/config.js";
import { promptSecret } from "../prompts.js";

export async function authGitHub(): Promise<void> {
  const token = await promptSecret("GitHub personal access token: ");
  if (!token.trim()) {
    console.error("Token cannot be empty");
    process.exit(1);
  }
  await setGitHubToken(token.trim());
  console.log("GitHub token saved.");
}
