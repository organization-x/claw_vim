export const samples: Record<string, string> = {
  "sample.ts": `// TypeScript sample
interface User {
  id: number;
  name: string;
  email?: string;
}

function greet(user: User): string {
  return \`Hello, \${user.name}!\`;
}

const alice: User = { id: 1, name: "Alice" };
console.log(greet(alice));
`,

  "sample.py": `# Python sample
from dataclasses import dataclass

@dataclass
class User:
    id: int
    name: str
    email: str | None = None

def greet(user: User) -> str:
    return f"Hello, {user.name}!"

if __name__ == "__main__":
    alice = User(id=1, name="Alice")
    print(greet(alice))
`,

  "sample.md": `# claude-vim

A simple desktop app pairing a **vim editor** with the **Claude CLI**.

## Why

- Vim keybindings everywhere
- Live markdown preview
- Claude in the same window

## Code

\`\`\`ts
function greet(name: string) {
  return \`Hello, \${name}!\`;
}
\`\`\`

> Markdown preview lands in M4.
`,
};
