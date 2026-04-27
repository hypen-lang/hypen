import { generateLLMIndex } from '@/lib/get-llm-text';

export const revalidate = false;

export function GET() {
  const content = generateLLMIndex();

  return new Response(content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
