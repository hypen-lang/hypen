import { source } from '@/lib/source';
import { getLLMText } from '@/lib/get-llm-text';

export const revalidate = false;

export async function GET() {
  const pages = source.getPages();

  const parts: string[] = [];

  for (const page of pages) {
    const text = await getLLMText(page as any);
    parts.push(text);
  }

  const content = parts.join('\n\n---\n\n');

  return new Response(content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
