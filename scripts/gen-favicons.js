/*
 * Régénération des icônes raster Nelth-AI — logo agrandi.
 * Rend le glyphe "N" (état final rempli) à partir du même path que les SVG,
 * avec un viewBox zoomé pour que le logo remplisse davantage le carré.
 *
 * Cibles de remplissage (hauteur du glyphe dans l'icône) :
 *   • favicons transparents (tab/ICO)      : 87 %  (avant 67,6 %)
 *   • apple-touch-icon (iOS)               : 85 %
 *   • icônes manifest "maskable" (PWA)     : 75 %  (zone sûre circulaire ~80 %)
 */
import sharp from '/home/z/my-project/node_modules/sharp';

const D =
        'M380 85.5c-.8.7-6.9 5.3-13.5 10-33.7 24.3-107.8 79.8-108.2 81.1-.4 1.1 14.6 9.6 47.7 27.1l18.5 9.8.3 40.5c.1 22.2-.1 40.7-.6 41.2-.4.4-6.6-2.8-13.7-7.1-39.9-24-52.5-31.2-53.5-30.6-.6.4-1 11.8-1 33.4 0 32.7 0 32.8 2.3 34.8 2.5 2.4 6.9 5.1 21.7 13.8 5.8 3.4 17.6 10.5 26.3 15.8 19.9 12.2 23.9 14.3 31.5 15.8 14.7 3.1 33-5.4 40.9-18.8 5.5-9.4 5.3-4.5 5.3-141.6 0-132.7.1-129.4-4-125.2m-225.9 45c-12.4 3.5-20.9 10.6-26.4 22.3l-3.2 6.7-.1 128.8c-.2 113.3 0 128.8 1.3 128.3 1.8-.7 16.9-11.6 33.6-24.1 6.5-5 21.7-16.1 33.6-24.8 40.9-29.8 57.1-41.9 57.1-42.8 0-1.4-5.4-4.5-34.5-19.9-14.8-7.9-28-14.9-29.1-15.6-2-1.2-2.2-2.3-2.9-27.3-.8-29.7.1-56.1 1.9-56.1.7 0 4.5 2.1 8.6 4.7 19.8 12.5 56.6 34.1 57.2 33.7.5-.3.8-15.5.8-33.9v-33.3l-3-2.6c-4.7-3.9-66.6-40.6-72-42.7-6.9-2.6-16.4-3.2-22.9-1.4';

function svgStr(vb, w, h, glyph, bg) {
        const rect = bg ? `<rect width="100%" height="100%" fill="${bg}"/>` : '';
        return (
                `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${w}" height="${h}">` +
                `${rect}<path d="${D}" fill="${glyph}" stroke="${glyph}" stroke-width="7" ` +
                `stroke-linecap="round" stroke-linejoin="round"/></svg>`
        );
}

async function render(vb, size, glyph, bg, out, ss = 4) {
        const big = size * ss;
        const buf = Buffer.from(svgStr(vb, big, big, glyph, bg));
        await sharp(buf).resize(size, size, { kernel: 'lanczos3' }).png().toFile(out);
        console.log('OK ', out, `(${size}x${size})`);
}

(async () => {
        // bbox glyphe+trait : x 120.83..387.50 (266.67), y 80.60..420.11 (339.51)
        const VB_TAB = '95.47 55.24 317.39 390.24'; // 87 %
        const VB_TOUCH = '90.88 50.65 326.57 399.42'; // 85 %
        const VB_MASK = '64.25 23.99 379.83 452.68'; // 75 %

        // Favicons transparents (glyphe sombre #0a0a0a — thème clair)
        await render(VB_TAB, 512, '#0a0a0a', null, 'public/static/favicon.png');
        await render(VB_TAB, 96, '#0a0a0a', null, 'public/static/favicon-96x96.png');
        await render(VB_TAB, 256, '#0a0a0a', null, 'public/static/favicon-master-256.png');

        // Apple touch (fond sombre #131318, glyphe clair #fafafa)
        await render(VB_TOUCH, 180, '#fafafa', '#131318', 'public/static/apple-touch-icon.png');

        // Icônes manifest PWA "maskable"
        await render(VB_MASK, 192, '#fafafa', '#131318', 'public/static/web-app-manifest-192x192.png');
        await render(VB_MASK, 512, '#fafafa', '#131318', 'public/static/web-app-manifest-512x512.png');

        console.log('Terminé.');
})().catch((e) => {
        console.error(e);
        process.exit(1);
});
