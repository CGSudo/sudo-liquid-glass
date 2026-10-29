// Settings window: ui/panel.html (embedded as resource 101) in a WebView2 control, inside a modal popup.
// The page talks back with postMessage strings, "kind:payload" (see the top of panel.html).
#include "LiquidGlassDialog.h"
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <dwmapi.h>
#include <wrl.h>
#include <string>
#include <vector>
#include <cstdio>
#include "WebView2.h"

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
extern "C" IMAGE_DOS_HEADER __ImageBase;

namespace {

struct State {
	float* p;
	const DialogHost& host;
	std::vector<float> orig;
	HWND wnd = nullptr;
	ComPtr<ICoreWebView2Controller> controller;
	ComPtr<ICoreWebView2> view;
	bool done = false, ok = false, previewOn = true, creating = true; // creating: WebView2 callbacks still due
	HRESULT failed = S_OK;
};

std::wstring Widen(const std::string& s)
{
	std::wstring w(MultiByteToWideChar(CP_UTF8, 0, s.data(), int(s.size()), nullptr, 0), L'\0');
	MultiByteToWideChar(CP_UTF8, 0, s.data(), int(s.size()), &w[0], int(w.size()));
	return w;
}

std::string Narrow(const std::wstring& w)
{
	std::string s(WideCharToMultiByte(CP_UTF8, 0, w.data(), int(w.size()), nullptr, 0, nullptr, nullptr), '\0');
	WideCharToMultiByte(CP_UTF8, 0, w.data(), int(w.size()), &s[0], int(s.size()), nullptr, nullptr);
	return s;
}

// %APPDATA%\Sudo Liquid Glass\<name>, creating the folder.
std::wstring DataPath(const wchar_t* name)
{
	PWSTR base = nullptr;
	std::wstring dir;
	if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &base))) dir = std::wstring(base) + L"\\Sudo Liquid Glass";
	CoTaskMemFree(base);
	CreateDirectoryW(dir.c_str(), nullptr);
	return dir + L"\\" + name;
}

std::string ReadFile(const std::wstring& path)
{
	std::string s;
	if (FILE* f = _wfopen(path.c_str(), L"rb")) {
		char buf[4096];
		for (size_t n; (n = fread(buf, 1, sizeof buf, f)) > 0;) s.append(buf, n);
		fclose(f);
	}
	return s;
}

void WriteFile(const std::wstring& path, const std::string& s)
{
	std::wstring tmp = path + L".tmp"; // write then swap, so a crash never leaves half a presets file
	if (FILE* f = _wfopen(tmp.c_str(), L"wb")) {
		bool good = fwrite(s.data(), 1, s.size(), f) == s.size();
		good = fclose(f) == 0 && good;
		if (good) MoveFileExW(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING);
	}
}

// JSON string literal, for handing text to the page.
std::wstring Quote(const std::wstring& s)
{
	std::wstring q = L"\"";
	for (wchar_t c : s) {
		if (c == L'"' || c == L'\\') q += L'\\', q += c;
		else if (c < 0x20) {
			wchar_t u[8];
			swprintf(u, 8, L"\\u%04x", unsigned(c));
			q += u;
		} else q += c;
	}
	return q + L"\"";
}

std::wstring Csv(const float* p)
{
	std::wstring s;
	for (int i = 0; i < kParamCount; i++) {
		wchar_t v[32];
		swprintf(v, 32, L"%s%g", i ? L"," : L"", p[i]);
		s += v;
	}
	return s;
}

// "1,2,3" -> exactly kParamCount finite numbers, or false.
bool ParseCsv(const std::wstring& s, float* out)
{
	const wchar_t* c = s.c_str();
	for (int i = 0; i < kParamCount; i++) {
		wchar_t* end = nullptr;
		float v = wcstof(c, &end);
		if (end == c || !(v == v) || v > 1e6f || v < -1e6f) return false;
		out[i] = v;
		c = end;
		if (i < kParamCount - 1) {
			if (*c != L',') return false;
			c++;
		}
	}
	return *c == 0;
}

std::wstring PanelHtml()
{
	HMODULE mod = HMODULE(&__ImageBase);
	HRSRC r = FindResourceW(mod, MAKEINTRESOURCEW(101), MAKEINTRESOURCEW(10)); // RT_RCDATA
	if (!r) return L"<p>Panel missing from the plug-in build.</p>";
	const char* data = (const char*)LockResource(LoadResource(mod, r));
	return Widen(std::string(data, SizeofResource(mod, r)));
}

void OnMessage(State& st, const std::wstring& msg)
{
	size_t colon = msg.find(L':');
	std::wstring kind = msg.substr(0, colon), body = colon == std::wstring::npos ? L"" : msg.substr(colon + 1);
	float v[kParamCount];
	if (kind == L"cancel") {
		st.done = true;
	} else if (kind == L"presets") {
		WriteFile(DataPath(L"presets.json"), Narrow(body));
	} else if (kind == L"link") {
		if (body.rfind(L"https://www.linkedin.com/", 0) == 0) ShellExecuteW(nullptr, L"open", body.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
	} else if (ParseCsv(body, v)) {
		memcpy(st.p, v, sizeof v);
		if (kind == L"ok") {
			st.ok = st.done = true;
		} else if (kind == L"params") {
			st.previewOn = true;
			if (st.host.allowPreview && st.host.preview) st.host.preview(st.p, st.host.ctx);
		} else if (kind == L"preview-off") {
			st.previewOn = false;
			if (st.host.allowPreview && st.host.preview) st.host.preview(st.orig.data(), st.host.ctx);
		} else if (kind == L"refresh" && st.host.refresh) {
			st.host.refresh(st.previewOn && st.host.allowPreview ? st.p : st.orig.data(), st.host.ctx);
		}
	}
}

void Ready(State& st)
{
	std::wstring opts = L"{docWidth:" + std::to_wstring(st.host.docWidthPt) + L",version:\"" + Widen(kVersion) +
		L"\",allowPreview:" + (st.host.allowPreview ? L"true" : L"false") + L"}";
	std::wstring script = L"init([" + Csv(st.p) + L"]," + Quote(Widen(ReadFile(DataPath(L"presets.json")))) + L"," + opts + L");";
	if (st.host.selfTest) script += st.host.selfTest;
	st.view->ExecuteScript(script.c_str(), nullptr);
}

void Create(State& st)
{
	std::wstring data = DataPath(L"WebView2"); // the default sits next to Illustrator.exe, which isn't writable
	HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, data.c_str(), nullptr,
		Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([&st](HRESULT hr, ICoreWebView2Environment* env) -> HRESULT {
			if (FAILED(hr) || !env) return st.failed = FAILED(hr) ? hr : E_FAIL, st.done = true, st.creating = false, S_OK;
			return env->CreateCoreWebView2Controller(st.wnd,
				Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([&st](HRESULT hr, ICoreWebView2Controller* c) -> HRESULT {
					st.creating = false;
					if (FAILED(hr) || !c) return st.failed = FAILED(hr) ? hr : E_FAIL, st.done = true, S_OK;
					st.controller = c;
					c->get_CoreWebView2(&st.view);
					ComPtr<ICoreWebView2Settings> s;
					st.view->get_Settings(&s);
					s->put_AreDevToolsEnabled(FALSE);
					s->put_AreDefaultContextMenusEnabled(FALSE);
					s->put_IsStatusBarEnabled(FALSE);
					s->put_IsZoomControlEnabled(FALSE);
					ComPtr<ICoreWebView2Controller2> c2;
					if (SUCCEEDED(c->QueryInterface(IID_PPV_ARGS(&c2)))) c2->put_DefaultBackgroundColor({ 255, 0x1d, 0x1f, 0x1e }); // no white flash
					RECT rc;
					GetClientRect(st.wnd, &rc);
					c->put_Bounds(rc);
					st.view->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>(
						[&st](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* a) -> HRESULT {
							LPWSTR m = nullptr;
							if (SUCCEEDED(a->TryGetWebMessageAsString(&m)) && m) OnMessage(st, m);
							CoTaskMemFree(m);
							return S_OK;
						}).Get(), nullptr);
					st.view->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>(
						[&st](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*) -> HRESULT {
							Ready(st);
							return S_OK;
						}).Get(), nullptr);
					// Links open in the default browser, never inside the panel.
					st.view->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
						[](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* a) -> HRESULT { return a->put_Handled(TRUE); }).Get(), nullptr);
					st.view->NavigateToString(PanelHtml().c_str());
					c->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
					return S_OK;
				}).Get());
		}).Get());
	if (FAILED(hr)) st.failed = hr, st.done = true, st.creating = false;
}

LRESULT CALLBACK Proc(HWND w, UINT msg, WPARAM wp, LPARAM lp)
{
	State* st = (State*)GetWindowLongPtrW(w, GWLP_USERDATA);
	switch (msg) {
	case WM_NCCREATE:
		SetWindowLongPtrW(w, GWLP_USERDATA, LONG_PTR(((CREATESTRUCTW*)lp)->lpCreateParams));
		break;
	case WM_SIZE:
		if (st && st->controller) {
			RECT rc;
			GetClientRect(w, &rc);
			st->controller->put_Bounds(rc);
		}
		return 0;
	case WM_GETMINMAXINFO:
		((MINMAXINFO*)lp)->ptMinTrackSize = { 380, 520 };
		return 0;
	case WM_CLOSE:
		if (st) st->done = true;
		return 0;
	}
	return DefWindowProcW(w, msg, wp, lp);
}

} // namespace

bool RunDialog(float* p, const DialogHost& host)
{
	// One window at a time: a second click in the Appearance panel brings the open one forward instead.
	static HWND open = nullptr;
	if (open) {
		SetForegroundWindow(open);
		FlashWindow(open, TRUE);
		return false;
	}
	HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
	HINSTANCE inst = HINSTANCE(&__ImageBase);
	static bool registered = false;
	if (!registered) {
		WNDCLASSEXW wc{ sizeof wc };
		wc.lpfnWndProc = Proc;
		wc.hInstance = inst;
		wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
		wc.hbrBackground = CreateSolidBrush(RGB(0x1d, 0x1f, 0x1e));
		wc.lpszClassName = L"SudoLiquidGlassPanel";
		registered = RegisterClassExW(&wc) != 0;
	}
	State st{ p, host, std::vector<float>(p, p + kParamCount) };
	HWND parent = HWND(host.parent);

	// Opens where it was last closed (this session); the first time, centred on Illustrator.
	static RECT last{};
	UINT dpi = GetDpiForSystem();
	int W = MulDiv(430, dpi, 96), H = MulDiv(760, dpi, 96);
	RECT pr{ 0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN) };
	if (parent) GetWindowRect(parent, &pr);
	RECT r = last.right > last.left ? last : RECT{ (pr.left + pr.right - W) / 2, (pr.top + pr.bottom - H) / 2, 0, 0 };
	if (last.right <= last.left) r.right = r.left + W, r.bottom = r.top + H;
	// Truly modal: every other window of Illustrator (Appearance panel included) ignores clicks while this is open.
	std::vector<HWND> blocked;
	EnumThreadWindows(GetCurrentThreadId(), [](HWND w, LPARAM l) -> BOOL {
		if (IsWindowVisible(w) && IsWindowEnabled(w)) ((std::vector<HWND>*)l)->push_back(w);
		return TRUE;
	}, LPARAM(&blocked));
	DWORD style = WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME;
	st.wnd = CreateWindowExW(WS_EX_DLGMODALFRAME, L"SudoLiquidGlassPanel", L"Sudo Liquid Glass", style,
		r.left, r.top, r.right - r.left, r.bottom - r.top, parent, nullptr, inst, &st);
	if (!st.wnd) return false;
	open = st.wnd;
	for (HWND w : blocked) EnableWindow(w, FALSE);
	BOOL dark = TRUE;
	DwmSetWindowAttribute(st.wnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &dark, sizeof dark);
	COLORREF caption = RGB(0x0d, 0x44, 0x31); // SUDO brand green title bar (Windows 11; ignored elsewhere)
	DwmSetWindowAttribute(st.wnd, 35 /* DWMWA_CAPTION_COLOR */, &caption, sizeof caption);
	ShowWindow(st.wnd, SW_SHOW);
	Create(st);
	MSG m;
	// Keep pumping until WebView2 has called back even if closed early: its callbacks point at this frame.
	while ((!st.done || st.creating) && GetMessageW(&m, nullptr, 0, 0) > 0) {
		TranslateMessage(&m);
		DispatchMessageW(&m);
	}
	for (HWND w : blocked) EnableWindow(w, TRUE);
	if (parent) SetActiveWindow(parent);
	GetWindowRect(st.wnd, &last);
	if (st.controller) st.controller->Close();
	st.view.Reset();
	st.controller.Reset();
	DestroyWindow(st.wnd);
	open = nullptr;
	if (FAILED(st.failed))
		MessageBoxW(parent, L"Sudo Liquid Glass needs the Microsoft Edge WebView2 Runtime to show its settings.\n"
			L"It comes with Windows 11; on Windows 10 install it from microsoft.com/edge/webview2.",
			L"Sudo Liquid Glass", MB_ICONWARNING);
	if (!st.ok) memcpy(p, st.orig.data(), sizeof(float) * kParamCount);
	if (com == S_OK || com == S_FALSE) CoUninitialize();
	return st.ok;
}
