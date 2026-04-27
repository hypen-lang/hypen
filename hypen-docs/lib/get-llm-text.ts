import { source } from '@/lib/source';

interface Page {
  data: {
    title: string;
    description?: string;
    body: unknown;
  };
  file: {
    path: string;
  };
}

/**
 * Get the text content of a documentation page formatted for LLM consumption.
 * Returns the raw MDX content prefixed with the page title and description.
 */
export async function getLLMText(page: Page): Promise<string> {
  const { readFileSync } = await import('fs');
  const { join } = await import('path');

  const filePath = join(process.cwd(), 'content/docs', page.file.path);

  try {
    const raw = readFileSync(filePath, 'utf-8');
    // Strip frontmatter
    const content = raw.replace(/^---[\s\S]*?---\n*/, '');
    return `# ${page.data.title}\n\n${page.data.description ? page.data.description + '\n\n' : ''}${content}`;
  } catch {
    return `# ${page.data.title}\n\n${page.data.description ?? ''}`;
  }
}

/**
 * Generate llms.txt index of all documentation pages.
 */
export function generateLLMIndex(): string {
  const pages = source.getPages();
  const lines = [
    '# Hypen Documentation',
    '',
    '> Hypen is a declarative UI language and runtime for building cross-platform applications.',
    '',
    '## Docs',
    '',
  ];

  for (const page of pages) {
    const data = page.data as unknown as { title: string; description?: string };
    const desc = data.description ? `: ${data.description}` : '';
    lines.push(`- [${data.title}](${page.url})${desc}`);
  }

  return lines.join('\n');
}
