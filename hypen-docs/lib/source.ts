import { docs } from '@/.source';
import { loader } from 'fumadocs-core/source';

// fumadocs-mdx returns files as a function, but fumadocs-core expects an array
// Use type assertion to work around the version mismatch
const mdxSource = docs.toFumadocsSource() as { files: unknown };
const filesArray = typeof mdxSource.files === 'function'
  ? (mdxSource.files as () => unknown[])()
  : mdxSource.files;

export const source = loader({
  baseUrl: '/docs',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: { files: filesArray } as any,
});
