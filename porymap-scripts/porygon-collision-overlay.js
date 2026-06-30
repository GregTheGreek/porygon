// porygon: collision overlay for Porymap
//
// Toggles a red overlay over every impassable block on the open map, so you can
// review collision at a glance after editing a map's blockdata.
//
// Load it in Porymap via: Options -> Custom Scripts... -> add this file.
// Then use Tools -> "porygon: Toggle Collision Overlay" (Ctrl+Shift+C).

const PORYGON_LAYER = 100;        // dedicated overlay layer, above the map
const METATILE_PX = 16;           // a block is 16x16 pixels
let porygonOverlayOn = false;

function porygonRedrawCollision() {
    overlay.clear(PORYGON_LAYER);
    if (!porygonOverlayOn) return;
    const dim = map.getDimensions();
    for (let y = 0; y < dim.height; y++) {
        for (let x = 0; x < dim.width; x++) {
            if (map.getCollision(x, y) > 0) {
                // semi-transparent red fill (AARRGGBB), no border
                overlay.addRect(x * METATILE_PX, y * METATILE_PX, METATILE_PX, METATILE_PX,
                                "#00000000", "#66ff0000", 0, PORYGON_LAYER);
            }
        }
    }
}

export function porygonToggleCollision() {
    porygonOverlayOn = !porygonOverlayOn;
    porygonRedrawCollision();
    utility.log("porygon: collision overlay " + (porygonOverlayOn ? "ON" : "off"));
}

// Keep the overlay in sync while it's on.
export function onBlockChanged(x, y, prevBlock, newBlock) {
    if (porygonOverlayOn) porygonRedrawCollision();
}

export function onMapOpened(mapName) {
    if (porygonOverlayOn) porygonRedrawCollision();
}

export function onProjectOpened(projectPath) {
    utility.registerAction("porygonToggleCollision", "porygon: Toggle Collision Overlay", "Ctrl+Shift+C");
}
