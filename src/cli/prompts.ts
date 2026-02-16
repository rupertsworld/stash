import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function promptSecret(question: string): Promise<string> {
  process.stdout.write(question);
  const rl = createInterface({
    input: process.stdin,
    output: new Writable({ write: (_chunk, _enc, cb) => cb() }),
    terminal: true,
  });
  try {
    return await rl.question("");
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}

export async function promptChoice(
  question: string,
  choices: string[],
): Promise<string> {
  const choiceStr = choices.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
  const answer = await prompt(`${question}\n${choiceStr}\n> `);
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < choices.length) return choices[idx];
  return answer;
}

export async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} (y/N) `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}
