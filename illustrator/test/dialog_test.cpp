// Runs the settings window without Illustrator: applies the "Ice" preset, saves a screenshot, presses OK, then
// checks the values that come back. Build and run with run_test.ps1.
#include "../Source/LiquidGlassDialog.h"
#include <windows.h>
#include <cstdio>
#include <cstring>
#include <thread>
#include <string>

const float kDefaults[kParamCount] = { -45, 0.6f, 80, 16, 20, 12, 30, 0.06f, 1.2f, 1, 1, 1, 0, 0.25f, 24, 8, 0, 1.5f, 0, 40, 24,
	0.32f, 1.2f, 1.5f, 1, 0, 12, 1, 1, 1,
	0, 0, 1, 0.2f, 0, -45, 1, 1, 1, 1, 1, 1 };
static int previews = 0;

// Screenshot of the window once the page has drawn, to `out` (BMP).
static void Shoot(const char* out)
{
	Sleep(2500);
	HWND w = FindWindowW(L"SudoLiquidGlassPanel", nullptr);
	if (!w) return;
	RECT r;
	GetWindowRect(w, &r);
	int W = r.right - r.left, H = r.bottom - r.top;
	HDC sdc = GetDC(nullptr), dc = CreateCompatibleDC(sdc);
	HBITMAP bmp = CreateCompatibleBitmap(sdc, W, H);
	SelectObject(dc, bmp);
	PrintWindow(w, dc, 2 /* PW_RENDERFULLCONTENT */);
	BITMAPINFOHEADER bi{ sizeof bi, W, -H, 1, 32, BI_RGB };
	std::string px(size_t(W) * H * 4, '\0');
	GetDIBits(dc, bmp, 0, H, &px[0], (BITMAPINFO*)&bi, DIB_RGB_COLORS);
	BITMAPFILEHEADER fh{ 0x4d42, DWORD(sizeof fh + sizeof bi + px.size()), 0, 0, sizeof fh + sizeof bi };
	if (FILE* f = fopen(out, "wb")) {
		fwrite(&fh, sizeof fh, 1, f);
		fwrite(&bi, sizeof bi, 1, f);
		fwrite(px.data(), 1, px.size(), f);
		fclose(f);
	}
	DeleteObject(bmp);
	DeleteDC(dc);
	ReleaseDC(nullptr, sdc);
}

int main(int argc, char** argv)
{
	SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
	float p[kParamCount];
	memcpy(p, kDefaults, sizeof p);
	p[3] = 40; // a size-scaled edge width: presets must keep it
	DialogHost h;
	h.preview = [](const float*, void*) { previews++; };
	h.selfTest = L"document.querySelectorAll('.card')[4].click();document.querySelectorAll('nav button')[3].click();"
		L"const sec=(t)=>[...document.querySelectorAll('section')].find((s)=>s.querySelector('h2').textContent===t);"
		L"sec('Stroke').querySelector('.switch input').click();"
		L"const g=sec('Inner glow').querySelector('select');g.value='1';g.dispatchEvent(new Event('change'));"
		L"sec('Stroke').scrollIntoView();"
		L"setTimeout(()=>document.getElementById('ok').click(),4000);";
	std::thread shot(Shoot, argc > 1 ? argv[1] : "panel.bmp");
	bool ok = RunDialog(p, h);
	shot.join();
	printf("ok=%d previews=%d edge=%g tint=%g glow=%g glowSize=%g blend=%g stroke=%g shadow=%g\n", ok, previews, p[3], p[12],
		p[25], p[26], p[30], p[31], p[13]);
	bool pass = ok && previews > 0 && p[3] == 40 && p[12] > 0.34f && p[12] < 0.36f && p[25] > 0.39f && p[26] == 14 &&
		p[30] == 1 && p[31] == 2 && p[13] > 0;
	puts(pass ? "PASS" : "FAIL");
	return pass ? 0 : 1;
}
