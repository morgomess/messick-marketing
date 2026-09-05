/*
 * add-blog.mjs — Messick Marketing blog publish injector (mechanical half of the
 * AIOS assisted-publish routine). Clones an existing post file as the skeleton so
 * the <head>, inline <style>, nav, tracking, and footer stay byte-identical, then
 * swaps only the content regions (title/meta/og, .post-hero, .post-body,
 * .related-section, .cta-strip). Injects a card at the top of blog/index.html and
 * promotes the new post to "featured" (demoting the previous featured card).
 *
 * No build step — messickmarketing.com is a static Pages site. Commit the new
 * blog/<slug>.html + blog/index.html and Pages serves them.
 *
 * Usage:
 *   node add-blog.mjs <manifest.json> [--dry]
 *
 * Manifest = JSON array of posts. Each post:
 *   {
 *     "slug": "how-patient-reviews-decide-who-gets-the-appointment",
 *     "title": "How Patient Reviews Decide Who Gets the Appointment",
 *     "emAccent": "(and What Yours Are Saying)",   // optional italic tail in the h1
 *     "category": "Reputation",                     // breadcrumb + post-category + card
 *     "metaDescription": "Patients read reviews before they call...",
 *     "date": "July 2026",                          // post-meta "Month Year"
 *     "isoDate": "2026-07-14",                      // optional; else derived from date as "2026-07"
 *     "ogImage": "/portfolio-assets/reviews.jpg",   // optional; else the site-wide /og-image.jpg
 *     "read": "6 min read",
 *     "excerpt": "Before a patient calls, they read your reviews...",  // index card blurb
 *     "bodyHtml": "<p>...</p>\n<h2>...</h2>...",     // inner of .post-body .inner (no author-bar)
 *     "related": [                                   // exactly 3 "Keep Reading" cards
 *       { "href": "/blog/what-is-content-marketing.html", "cat": "Content Marketing", "title": "What Is Content Marketing?" },
 *       ...
 *     ]
 *   }
 *
 * bodyHtml is trusted HTML (built by the routine). Text fields are auto-escaped.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const INDEX = path.join(ROOT, 'index.html');
const TEMPLATE = path.join(ROOT, 'how-to-create-a-content-strategy.html');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const manifestPath = process.argv[2];
const dry = process.argv.includes('--dry');
if (!manifestPath) die('usage: node add-blog.mjs <manifest.json> [--dry]');

const posts = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(posts)) die('manifest must be a JSON array of posts');

const template = fs.readFileSync(TEMPLATE, 'utf8');
let index = fs.readFileSync(INDEX, 'utf8');
const gridAnchor = '<div class="blog-grid">';
if (!index.includes(gridAnchor)) die('could not find .blog-grid anchor in blog/index.html');

const added = [];
for (const p of posts) {
  for (const k of ['slug', 'title', 'category', 'metaDescription', 'date', 'read', 'excerpt', 'bodyHtml', 'related'])
    if (!p[k]) die(`post "${p.slug || p.title || '?'}" missing required field: ${k}`);
  if (!Array.isArray(p.related) || p.related.length !== 3)
    die(`post "${p.slug}" must have exactly 3 related cards`);

  const dest = path.join(ROOT, p.slug + '.html');
  if (fs.existsSync(dest)) { console.log(`  skip (exists): ${p.slug}`); continue; }
  if (index.includes(`/blog/${p.slug}.html`)) { console.log(`  skip (card exists): ${p.slug}`); continue; }

  // Canonical form is extensionless, matching sitemap.xml. GitHub Pages serves both
  // /blog/<slug> and /blog/<slug>.html with a 200, so the canonical is what settles it.
  const url = `https://messickmarketing.com/blog/${p.slug}`;
  const titleTag = `${esc(p.title)} | Messick Marketing Blog`;
  const ogImage = p.ogImage
    ? (/^https?:/.test(p.ogImage) ? p.ogImage : `https://messickmarketing.com${p.ogImage}`)
    : 'https://messickmarketing.com/og-image.jpg';
  // "July 2026" -> "2026-07". Month precision unless the manifest supplies isoDate.
  const MONTHS = ['january','february','march','april','may','june',
                  'july','august','september','october','november','december'];
  const isoDate = p.isoDate || (() => {
    const m = String(p.date).trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (!m) die(`post "${p.slug}": date "${p.date}" is not "Month YYYY" and no isoDate given`);
    const i = MONTHS.indexOf(m[1].toLowerCase());
    if (i < 0) die(`post "${p.slug}": unrecognised month in date "${p.date}"`);
    return `${m[2]}-${String(i + 1).padStart(2, '0')}`;
  })();
  const h1 = p.emAccent
    ? `${esc(p.title)} <em>${esc(p.emAccent)}</em>`
    : esc(p.title);

  // --- new post file from the template skeleton ---
  let html = template;
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${titleTag}</title>`);
  html = html.replace(/<meta name="description" content="[\s\S]*?"\/>/,
    `<meta name="description" content="${esc(p.metaDescription)}"/>`);
  html = html.replace(/<meta property="og:title" content="[\s\S]*?"\/>/,
    `<meta property="og:title" content="${esc(p.title)}"/>`);
  html = html.replace(/<meta property="og:url" content="[\s\S]*?"\/>/,
    `<meta property="og:url" content="${url}"/>`);
  html = html.replace(/<link rel="canonical" href="[\s\S]*?"\/>/,
    `<link rel="canonical" href="${url}"/>`);
  html = html.replace(/<meta property="og:description" content="[\s\S]*?"\/>/,
    `<meta property="og:description" content="${esc(p.metaDescription)}"/>`);
  html = html.replace(/<meta property="og:image" content="[\s\S]*?"\/>/,
    `<meta property="og:image" content="${ogImage}"/>`);
  html = html.replace(/<meta name="twitter:title" content="[\s\S]*?"\/>/,
    `<meta name="twitter:title" content="${esc(p.title)}"/>`);
  html = html.replace(/<meta name="twitter:description" content="[\s\S]*?"\/>/,
    `<meta name="twitter:description" content="${esc(p.metaDescription)}"/>`);
  html = html.replace(/<meta name="twitter:image" content="[\s\S]*?"\/>/,
    `<meta name="twitter:image" content="${ogImage}"/>`);

  // BlogPosting: the template carries one, so swap its fields rather than appending a second.
  const blogPosting = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: p.title,
    description: p.metaDescription,
    datePublished: isoDate,
    dateModified: isoDate,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    image: ogImage,
    author: {
      '@type': 'Person',
      name: 'Morgan Messick',
      jobTitle: 'Founder',
      worksFor: { '@type': 'Organization', name: 'Messick Marketing', url: 'https://messickmarketing.com/' }
    },
    publisher: {
      '@type': 'Organization',
      name: 'Messick Marketing',
      logo: { '@type': 'ImageObject', url: 'https://messickmarketing.com/logo.png' }
    }
  }, null, 2);
  // Tempered so the wildcard cannot cross a </script>. A plain [\s\S]*? here would start at an
  // earlier VideoObject or FAQPage block in the skeleton and swallow it.
  const ldRe = /<script type="application\/ld\+json">(?:(?!<\/script>)[\s\S])*?"@type":\s*"BlogPosting"(?:(?!<\/script>)[\s\S])*?<\/script>/;
  if (!ldRe.test(html)) die(`post "${p.slug}": BlogPosting block not found in the template skeleton`);
  html = html.replace(ldRe, `<script type="application/ld+json">\n${blogPosting}\n</script>`);

  const hero =
`<section class="post-hero">
  <div class="inner">
    <div class="breadcrumb"><a href="/blog/">Blog</a><span>/</span><a href="#">${esc(p.category)}</a></div>
    <span class="post-category">${esc(p.category)}</span>
    <h1>${h1}</h1>
    <div class="post-meta">
      <span>Messick Marketing</span><span class="divider"></span>
      <span>${esc(p.date)}</span><span class="divider"></span>
      <span>${esc(p.read)}</span>
    </div>
  </div>
</section>`;
  html = html.replace(/<section class="post-hero">[\s\S]*?<\/section>/, hero);

  const authorBar =
`    <div class="author-bar">
      <div class="author-info">
        <div class="author-name">Messick Marketing</div>
        <div class="author-bio">We build content strategies for healthcare practices and mission-driven businesses, then execute them. If you want content that goes beyond a calendar, let's talk about what that looks like for your practice.</div>
      </div>
    </div>`;
  const article =
`<article class="post-body">
  <div class="inner">
    ${p.bodyHtml.trim()}

${authorBar}
  </div>
</article>`;
  html = html.replace(/<article class="post-body">[\s\S]*?<\/article>/, article);

  const relatedCards = p.related.map(r =>
`      <a class="related-card" href="${esc(r.href)}">
        <div class="rc-cat">${esc(r.cat)}</div>
        <div class="rc-title">${esc(r.title)}</div>
        <div class="rc-arrow">&#x2197;</div>
      </a>`).join('\n');
  const related =
`<section class="related-section">
  <div class="inner">
    <p class="eyebrow">Keep Reading</p>
    <div class="related-grid">
${relatedCards}
    </div>
  </div>
</section>`;
  html = html.replace(/<section class="related-section">[\s\S]*?<\/section>/, related);

  const cta =
`<section class="cta-strip">
  <h2>Content that actually<br><em>moves the needle.</em></h2>
  <p>We build your content strategy and handle the execution, so the right people find your practice. You focus on patients.</p>
  <a href="/#contact" class="btn-white">Let's Get Started</a>
</section>`;
  html = html.replace(/<section class="cta-strip">[\s\S]*?<\/section>/, cta);

  // --- index card: demote current featured, insert new as featured at top ---
  index = index.replace('<a class="blog-card card-featured"', '<a class="blog-card"');
  const card =
`
      <!-- POST: ${p.slug} -->
      <a class="blog-card card-featured" href="/blog/${p.slug}.html">
        <div class="card-body">
          <span class="card-category">${esc(p.category)}</span>
          <div class="card-title">${esc(p.title)}</div>
          <p class="card-excerpt">${esc(p.excerpt)}</p>
        </div>
        <div class="card-footer">
          <span class="card-meta">${esc(p.read)}</span>
          <span class="card-arrow">&#x2197;</span>
        </div>
      </a>
`;
  index = index.replace(gridAnchor, gridAnchor + card);

  if (!dry) fs.writeFileSync(dest, html);
  added.push({ slug: p.slug, url });
  console.log(`  + ${p.slug}`);
}

if (!added.length) { console.log('Nothing new to add.'); process.exit(0); }
if (!dry) fs.writeFileSync(INDEX, index);

console.log(`\n${dry ? '[dry] ' : ''}Wrote ${added.length} post(s) + index card(s).`);
console.log('New URLs:');
added.forEach(a => console.log('  ' + a.url));
