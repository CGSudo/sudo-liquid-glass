// Settings window: the HTML panel (ui/panel.html) hosted in WebView2. Kept free of Illustrator SDK types so
// test/dialog_test.cpp can run it on its own.
#pragma once
#include <cwchar> // wchar_t: the SDK projects build with /Zc:wchar_t-

constexpr int kParamCount = 42; // = glass_core::Params
extern const float kDefaults[kParamCount];
constexpr const char* kVersion = "0.7.0";

struct DialogHost {
	void* parent = nullptr;                           // owner window (HWND)
	float docWidthPt = 612;                           // stands in for the film frame width (grain sizes)
	bool allowPreview = true;
	void (*preview)(const float* p, void* ctx) = nullptr; // apply these values to the artboard now
	void (*refresh)(const float* p, void* ctx) = nullptr; // re-read the artwork behind the glass and redraw
	void* ctx = nullptr;
	const wchar_t* selfTest = nullptr;                // test only: script run once the panel is ready
};

// Modal. Edits `p` in place and returns true on OK; on Cancel `p` is left as it came in.
bool RunDialog(float* p, const DialogHost& host);
