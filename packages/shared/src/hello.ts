export function hello(name: string = 'World'): string {
  return `Hello, ${name}!`;
}

export function helloWorld(): string {
  return hello();
}
