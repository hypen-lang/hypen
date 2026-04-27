import { source } from '@/lib/source';
import {
  DocsPage,
  DocsBody,
  DocsDescription,
  DocsTitle,
} from 'fumadocs-ui/page';
import { notFound } from 'next/navigation';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXContent } from 'mdx/types';
import { LLMCopyButton } from '@/components/llm-copy-button';
import { ViewOptions } from '@/components/view-options';

interface PageData {
  title: string;
  description?: string;
  body: MDXContent;
  toc: { title: string; url: string; depth: number }[];
  full?: boolean;
}

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const data = page.data as unknown as PageData;
  const MDX = data.body;
  const slugPath = params.slug?.join('/') ?? '';
  const markdownUrl = `/llms.mdx/${slugPath}`;
  const githubUrl = `https://github.com/hypen-lang/hypen/blob/main/hypen-docs/content/docs/${page.file.path}`;

  return (
    <DocsPage toc={data.toc} full={data.full}>
      <div className="flex flex-row flex-wrap items-center gap-1.5 mb-4 not-prose">
        <LLMCopyButton markdownUrl={markdownUrl} />
        <ViewOptions markdownUrl={markdownUrl} githubUrl={githubUrl} />
      </div>
      <DocsTitle>{data.title}</DocsTitle>
      <DocsDescription>{data.description}</DocsDescription>
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents }} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
