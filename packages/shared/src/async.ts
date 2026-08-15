import { hello } from './hello.js';

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function asyncGreet(name: string = 'World', ms: number = 0): Promise<string> {
  await delay(ms);
  return hello(name);
}

export async function greetAll(names: string[], ms: number = 0): Promise<string[]> {
  return Promise.all(names.map((name) => asyncGreet(name, ms)));
}
