import { input, password, select, confirm as inquirerConfirm } from "@inquirer/prompts";

export async function prompt(question: string): Promise<string> {
  return input({ message: question });
}

export async function promptSecret(question: string): Promise<string> {
  return password({ message: question });
}

export async function promptChoice(
  question: string,
  choices: string[],
): Promise<string> {
  return select({
    message: question,
    choices: choices.map((c) => ({ value: c, name: c })),
  });
}

export async function confirm(question: string): Promise<boolean> {
  return inquirerConfirm({ message: question, default: false });
}
