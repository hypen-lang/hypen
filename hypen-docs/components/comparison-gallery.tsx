import manifest from "@/lib/comparison-manifest.json";

const PLATFORM_ORDER = ["iOS", "Android", "Web", "Desktop", "Canvas"];

export function ComparisonGallery() {
  return (
    <div className="not-prose mt-8 space-y-12">
      {manifest.sections.map(section => (
        <section key={section.title}>
          <h2 className="mb-5 border-b pb-2 text-2xl font-semibold">{section.title}</h2>
          <div className="space-y-8">
            {section.items.map(item => (
              <article id={item.deeplink} key={item.deeplink} className="scroll-mt-20">
                <h3 className="mb-3 text-lg font-semibold">{item.name}</h3>
                <img
                  src={item.image}
                  alt={`${item.name} rendered on ${PLATFORM_ORDER.join(", ")}`}
                  loading="lazy"
                  className="h-auto w-full rounded-lg border bg-white"
                />
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
