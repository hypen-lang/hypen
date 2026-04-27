import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <div className="flex items-center gap-2">
          <img
            src="/favicon.svg"
            alt="Hypen"
            width={28}
            height={28}
            className="rounded"
          />
          <span className="font-bold text-lg">Hypen</span>
        </div>
      ),
    },
    links: [
      {
        text: 'Documentation',
        url: '/docs',
        active: 'nested-url',
      },
      {
        text: 'Home',
        url: 'https://hypen.space',
      },
    ],
    githubUrl: 'https://github.com/hypen-lang/hypen',
  };
}
