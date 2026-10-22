// Tiny replacement for vite-plugin-singlefile: after the build, inline the emitted JS
// and CSS into index.html so the whole app is one file (open from disk, host anywhere,
// or publish as a Claude artifact). Only for `vite build`; the dev server is untouched.
export function inlineIntoHtml() {
  return {
    name: 'inline-into-html',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find(f => f.type === 'asset' && f.fileName.endsWith('.html'));
      if (!html) return;
      let text = String(html.source);
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type === 'chunk' && name.endsWith('.js')) {
          const re = new RegExp(`<script type="module"[^>]*src="[^"]*${escape(name)}"[^>]*></script>`);
          if (!re.test(text)) continue;
          const code = file.code.replace(/<\/script/gi, '<\\/script');
          text = text.replace(re, () => `<script type="module">\n${code}</script>`);
          delete bundle[name];
        } else if (file.type === 'asset' && name.endsWith('.css')) {
          const re = new RegExp(`<link rel="stylesheet"[^>]*href="[^"]*${escape(name)}"[^>]*>`);
          if (!re.test(text)) continue;
          text = text.replace(re, () => `<style>\n${String(file.source)}</style>`);
          delete bundle[name];
        }
      }
      html.source = text;
    },
  };
}
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
