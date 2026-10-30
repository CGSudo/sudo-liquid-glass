// ExtendScript side of the panel: forwards to the LiquidGlass plug-in (C++), which does the work.
// Selectors: "state" (what's selected, as JSON), "apply" / "make" (42 comma-separated settings), "refresh".
function lg(selector, input) {
    try {
        return app.sendScriptMessage("LiquidGlass", selector, input);
    } catch (e) {
        return selector === "state" ? "" : "The Liquid Glass plug-in isn't loaded: " + e;
    }
}
