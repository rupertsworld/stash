import { createInterface } from "node:readline/promises";

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
  // Simple secret prompt - in production you'd want to hide input
  return prompt(question);
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
