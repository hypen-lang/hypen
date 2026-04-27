import { defineDocs, defineConfig } from 'fumadocs-mdx/config';
import { rehypeCode } from 'fumadocs-core/mdx-plugins';
import hypenGrammar from './lib/hypen.tmLanguage.json';

export const docs = defineDocs({
  dir: 'content/docs',
});

export default defineConfig({
  mdxOptions: {
    rehypePlugins: [
      [rehypeCode, {
        langs: [
          {
            ...hypenGrammar,
            name: 'hypen',
            aliases: ['hyp'],
          },
        ],
      }],
    ],
  },
});
