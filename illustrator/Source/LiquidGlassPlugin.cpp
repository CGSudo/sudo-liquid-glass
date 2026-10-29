// Liquid Glass as an Illustrator Live Effect (Effect > Stylize > Liquid Glass...).
//
// Lives in the Appearance panel like any effect: double-click it there to edit, and Illustrator re-runs it whenever
// the shape changes or moves. Go: rasterize the art *below* the shape (the backdrop) and the shape itself (the mask),
// run the Rust engine in-process, return [shadow raster, glass raster] in place of the shape.
#include "LiquidGlass.h"
#include <vector>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <algorithm>
#include <cstdarg>
#include <share.h>
#include <string>

const float kDefaults[kParamCount] = { -45, 0.6f, 80, 16, 20, 12, 30, 0.06f, 1.2f, 1, 1, 1, 0, 0.25f, 24, 8, 0, 1.5f, 0, 40, 24, 0.32f, 1.2f, 1.5f, 1, 0, 12, 1, 1, 1,
	0, 0, 1, 0.2f, 0, -45, 1, 1, 1, 1, 1, 1 };
// Lengths: stored in pt, converted to px at render.
static const int kLengths[] = { 3, 5, 14, 15, 17, 19, 20, 22, 26, 31 };

static AIDictKey ParamKey(int i)
{
	char k[8];
	snprintf(k, sizeof k, "lg%d", i);
	return sAIDictionary->Key(k);
}

static void ReadParams(ConstAIDictionaryRef d, float* p)
{
	for (int i = 0; i < kParamCount; i++) {
		AIReal v = kDefaults[i];
		if (d && sAIDictionary->IsKnown(d, ParamKey(i))) sAIDictionary->GetRealEntry(d, ParamKey(i), &v);
		p[i] = (float)v;
	}
}

static void WriteParams(AIDictionaryRef d, const float* p)
{
	for (int i = 0; i < kParamCount; i++) sAIDictionary->SetRealEntry(d, ParamKey(i), p[i]);
}

struct Image {
	int w = 0, h = 0, ch = 0;
	std::vector<unsigned char> px;
	AIRealMatrix m{};
};

// Rasterizes `set` over `r` at `ppi` into `img` (raw channel order: ARGB or RGB). The temporary raster is discarded.
static AIErr Rasterize(AIArtSet set, AIRasterizeType type, AIReal ppi, AIRealRect r, AIArtHandle into, Image& img)
{
	AIRasterizeSettings s;
	s.type = type;
	s.resolution = ppi;
	s.antialiasing = 2;
	AIArtHandle ras = nullptr;
	AIErr e = sAIRasterize->Rasterize(set, &s, &r, kPlaceInsideOnTop, into, &ras, nullptr);
	if (e) return e;
	AIRasterRecord rec;
	e = sAIRaster->GetRasterInfo(ras, &rec);
	if (!e) e = sAIRaster->GetRasterMatrix(ras, &img.m);
	if (!e) {
		img.w = rec.bounds.right - rec.bounds.left;
		img.h = rec.bounds.bottom - rec.bounds.top;
		img.ch = rec.bitsPerPixel / 8;
		img.px.assign(size_t(img.w) * img.h * img.ch, 0);
		AISlice sl;
		sl.Init();
		sl.right = img.w;
		sl.bottom = img.h;
		sl.back = img.ch;
		AITile t;
		memset(&t, 0, sizeof t);
		t.data = img.px.data();
		t.bounds = sl;
		t.rowBytes = img.w * img.ch;
		t.colBytes = img.ch;
		for (int i = 0; i < img.ch; i++) t.channelInterleave[i] = (ai::int16)i;
		e = sAIRaster->GetRasterTile(ras, &sl, &t, &sl);
	}
	sAIArt->DisposeArt(ras);
	return e;
}

// New RGBA raster (straight alpha) on top inside `group`, placed with matrix `m`. Skipped when fully transparent.
static AIErr AddRaster(AIArtHandle group, const std::vector<unsigned char>& rgba, int w, int h, const AIRealMatrix& m)
{
	bool any = false;
	for (size_t i = 3; i < rgba.size() && !any; i += 4) any = rgba[i] != 0;
	if (!any) return kNoErr;
	AIArtHandle ras = nullptr;
	AIErr e = sAIArt->NewArt(kRasterArt, kPlaceInsideOnTop, group, &ras);
	if (e) return e;
	AIRasterRecord rec;
	rec.colorSpace = kAlphaRGBColorSpace;
	rec.bitsPerPixel = 32;
	rec.bounds.left = rec.bounds.top = 0;
	rec.bounds.right = w;
	rec.bounds.bottom = h;
	rec.byteWidth = w * 4;
	e = sAIRaster->SetRasterInfo(ras, &rec);
	AIRealMatrix mm = m;
	if (!e) e = sAIRaster->SetRasterMatrix(ras, &mm);
	if (e) return e;
	std::vector<unsigned char> argb(rgba.size());
	for (size_t i = 0; i < rgba.size(); i += 4) {
		argb[i] = rgba[i + 3];
		argb[i + 1] = rgba[i];
		argb[i + 2] = rgba[i + 1];
		argb[i + 3] = rgba[i + 2];
	}
	AISlice sl;
	sl.Init();
	sl.right = w;
	sl.bottom = h;
	sl.back = 4;
	AITile t;
	memset(&t, 0, sizeof t);
	t.data = argb.data();
	t.bounds = sl;
	t.rowBytes = w * 4;
	t.colBytes = 4;
	for (int i = 0; i < 4; i++) t.channelInterleave[i] = (ai::int16)i;
	return sAIRaster->SetRasterTile(ras, &sl, &t, &sl);
}

static bool IsHidden(AIArtHandle a)
{
	ai::int32 attr = 0;
	sAIArt->GetArtUserAttr(a, kArtHidden, &attr);
	return attr != 0;
}

// Signature of the art below a glass: newest edit time plus item count (the count catches deletions).
struct Below {
	size_t stamp = 0, count = 0;
	bool operator!=(const Below& o) const { return stamp != o.stamp || count != o.count; }
};

static void Stamp(AIArtHandle a, Below& sig)
{
	size_t t = 0;
	if (!sAIArt->GetArtTimeStamp(a, kAITimeStampOfArt, &t)) sig.stamp = std::max(sig.stamp, t);
	if (!sAIArt->GetArtTimeStamp(a, kAITimeStampOfDescendents, &t)) sig.stamp = std::max(sig.stamp, t);
	sig.count++;
}

// Everything painted below `src`: later siblings at each level up the tree, then the visible layers underneath.
// `set` (optional) gets the visible art; `sig` covers hidden art too, so hiding something below also re-runs the glass.
static void AddArtBelow(AIArtHandle src, AIArtSet set, Below& sig)
{
	for (AIArtHandle a = src; a;) {
		AIArtHandle s = nullptr;
		for (sAIArt->GetArtSibling(a, &s); s; sAIArt->GetArtSibling(s, &s)) {
			Stamp(s, sig);
			if (set && !IsHidden(s)) sAIArtSet->AddArtToArtSet(set, s);
		}
		AIArtHandle parent = nullptr;
		if (sAIArt->GetArtParent(a, &parent) || !parent) break;
		a = parent;
	}
	AILayerHandle layer = nullptr, up = nullptr;
	if (sAIArt->GetLayerOfArt(src, &layer) || !layer) return;
	while (!sAILayer->GetLayerParent(layer, &up) && up) layer = up;
	for (AILayerHandle l = layer; !sAILayer->GetNextLayer(l, &l) && l;) {
		AIBoolean visible = false;
		AIArtHandle art = nullptr;
		sAILayer->GetLayerVisible(l, &visible);
		if (sAIArt->GetFirstArtOfLayer(l, &art) || !art) continue;
		Stamp(art, sig);
		if (set && visible) sAIArtSet->AddArtToArtSet(set, art);
	}
}

// Glasses rendered in this session, with the signature of the art below them at their last render.
struct Tracked {
	AIDocumentHandle doc;
	AIArtHandle src;
	Below below;
};
static std::vector<Tracked> gGlasses;

static void Track(AIArtHandle src, const Below& below)
{
	AIDocumentHandle doc = nullptr;
	sAIDocument->GetDocument(&doc);
	for (auto& g : gGlasses)
		if (g.doc == doc && g.src == src) {
			g.below = below;
			return;
		}
	gGlasses.push_back({ doc, src, below });
}

// Illustrator re-runs an effect when its own art changes, not when the art below it does: re-run those glasses here.
static void BackdropChanged()
{
	static bool busy = false;
	if (busy) return;
	busy = true;
	AIDocumentHandle doc = nullptr;
	sAIDocument->GetDocument(&doc);
	for (size_t i = 0; i < gGlasses.size();) {
		Tracked& g = gGlasses[i];
		if (g.doc != doc) { // other documents are checked when they are active again
			i++;
			continue;
		}
		if (!sAIArt->ValidArt(g.src, false)) {
			gGlasses.erase(gGlasses.begin() + i);
			continue;
		}
		Below now;
		AddArtBelow(g.src, nullptr, now);
		if (now != g.below) {
			g.below = now;
			sAIArt->MarkDirty(g.src, true); // dirty the art style: Illustrator re-runs Go on the next redraw
		}
		i++;
	}
	busy = false;
}

static AIErr RenderGlass(AILiveEffectGoMessage* msg)
{
	float p[kParamCount];
	ReadParams(msg->parameters, p);
	AIArtHandle art = msg->art;
	short type = kUnknownArt;
	sAIArt->GetArtType(art, &type);
	if (type == kRasterArt || type == kPlacedArt) return kNoErr; // images aren't shapes: left untouched

	AIRealRect b;
	AIErr e = sAIArt->GetArtBounds(art, &b);
	if (e) return e;
	// Room for lens reach, shadow, dim halo and liquid bridges (pt).
	// Lens reach mirrors glass_core::lens_reach (at the usual 2 px per pt), so the lens never samples past the backdrop.
	float lensPx = std::min(48.f, p[3] * 2) + std::max(0.f, p[3] * 2 - 48) * 0.25f, lens = std::min(150.f, lensPx * p[2] / 100 * 2);
	AIReal m = std::max({ p[3], lens, p[14] * 1.5f + std::fabs(p[15]), p[kDim] > 0 ? p[19] * 1.5f : 0.f, p[20] }) + p[kFrost] * 2 + 4;
	AIRealRect r = { b.left - m, b.top + m, b.right + m, b.bottom - m };
	AIReal area = (r.right - r.left) * (r.top - r.bottom);
	AIReal ppi = 144; // 2 px per pt; capped so very large shapes stay fast
	const AIReal maxPx = 4.0e6;
	if (area * (ppi / 72) * (ppi / 72) > maxPx) ppi = 72 * std::sqrt(maxPx / area);

	AIArtHandle group = nullptr;
	e = sAIArt->NewArt(kGroupArt, kPlaceAbove, art, &group);
	if (e) return e;

	// One mask per part, so separate shapes in a group fuse with a liquid bridge instead of a plain union.
	// Text arrives as a group of letter outlines: one mask keeps the word readable instead of melting the letters.
	short srcType = kUnknownArt;
	if (msg->srcArt) sAIArt->GetArtType(msg->srcArt, &srcType);
	std::vector<AIArtHandle> parts;
	if (type == kGroupArt && srcType != kTextFrameArt) {
		AIArtHandle c = nullptr;
		for (sAIArt->GetArtFirstChild(art, &c); c; sAIArt->GetArtSibling(c, &c)) parts.push_back(c);
	}
	if (parts.empty()) parts.push_back(art);

	int w = 0, h = 0;
	AIRealMatrix mat{};
	std::vector<unsigned char> masks;
	Image img;
	for (AIArtHandle part : parts) {
		AIArtSet set = nullptr;
		sAIArtSet->NewArtSet(&set);
		sAIArtSet->AddArtToArtSet(set, part);
		e = Rasterize(set, kRasterizeARGB, ppi, r, group, img);
		sAIArtSet->DisposeArtSet(&set);
		if (e) break;
		if (!w) {
			w = img.w;
			h = img.h;
			mat = img.m;
		}
		size_t base = masks.size();
		masks.resize(base + size_t(w) * h, 0);
		for (int y = 0; y < std::min(h, img.h); y++)
			for (int x = 0; x < std::min(w, img.w); x++) masks[base + size_t(y) * w + x] = img.px[(size_t(y) * img.w + x) * img.ch];
	}
	bool any = std::any_of(masks.begin(), masks.end(), [](unsigned char v) { return v != 0; });
	if (e || !w || !any) {
		sAIArt->DisposeArt(group);
		return e; // no filled shape here (glass needs a fill to know its outline): leave the art as it is
	}

	// Backdrop over white paper; empty when nothing is below.
	std::vector<unsigned char> bd(size_t(w) * h * 4, 255);
	if (msg->srcArt) {
		AIArtSet set = nullptr;
		sAIArtSet->NewArtSet(&set);
		Below sig;
		AddArtBelow(msg->srcArt, set, sig);
		Track(msg->srcArt, sig);
		size_t n = 0;
		sAIArtSet->CountArtSet(set, &n);
		if (n && !Rasterize(set, kRasterizeRGB, ppi, r, group, img)) {
			for (int y = 0; y < std::min(h, img.h); y++)
				for (int x = 0; x < std::min(w, img.w); x++)
					for (int c = 0; c < 3; c++) bd[(size_t(y) * w + x) * 4 + c] = img.px[(size_t(y) * img.w + x) * img.ch + c];
		}
		sAIArtSet->DisposeArtSet(&set);
	}

	float px[kParamCount];
	memcpy(px, p, sizeof px);
	for (int i : kLengths) px[i] = p[i] * float(ppi / 72);
	std::vector<unsigned char> glass(size_t(w) * h * 4), under(size_t(w) * h * 4);
	if (lg_render(px, bd.data(), masks.data(), unsigned(masks.size() / (size_t(w) * h)), w, h, glass.data(), under.data())) {
		sAIArt->DisposeArt(group);
		return kCantHappenErr;
	}
	e = AddRaster(group, under, w, h, mat);
	if (!e) e = AddRaster(group, glass, w, h, mat); // added last = on top
	if (e) {
		sAIArt->DisposeArt(group);
		return e;
	}
	sAIArt->DisposeArt(art);
	msg->art = group;
	return kNoErr;
}

// Finds the Liquid Glass effect in `art`'s appearance, wherever it sits: on the whole object or on a fill row.
// `found` stays valid while `parser` is alive and unchanged (EditEffectParameters needs that). With `count`, it keeps
// going and counts every copy.
static bool FindGlass(AIStyleParser parser, AIArtHandle art, AILiveEffectHandle effect, AIArtStyleHandle* style,
	AIParserLiveEffect* found, int* count = nullptr)
{
	if (sAIArtStyle->GetArtStyle(art, style) || !*style || sAIArtStyleParser->ParseStyle(parser, *style)) return false;
	auto is = [&](AIParserLiveEffect e) {
		AILiveEffectHandle h = nullptr;
		if (!e || sAIArtStyleParser->GetLiveEffectHandle(e, &h) || h != effect) return false;
		*found = e;
		return count ? (++*count, false) : true;
	};
	AIParserLiveEffect e = nullptr;
	for (ai::int32 i = 0, n = sAIArtStyleParser->CountPreEffects(parser); i < n; i++)
		if (!sAIArtStyleParser->GetNthPreEffect(parser, i, &e) && is(e)) return true;
	for (ai::int32 i = 0, n = sAIArtStyleParser->CountPostEffects(parser); i < n; i++)
		if (!sAIArtStyleParser->GetNthPostEffect(parser, i, &e) && is(e)) return true;
	for (ai::int32 i = 0, n = sAIArtStyleParser->CountPaintFields(parser); i < n; i++) {
		AIParserPaintField pf = nullptr;
		if (sAIArtStyleParser->GetNthPaintField(parser, i, &pf)) continue;
		for (ai::int32 j = 0, m = sAIArtStyleParser->CountEffectsOfPaintField(pf); j < m; j++)
			if (!sAIArtStyleParser->GetNthEffectOfPaintField(pf, j, &e) && is(e)) return true;
	}
	return false;
}

// How many Liquid Glass effects `art` carries.
static int CountGlass(AIArtHandle art, AILiveEffectHandle effect)
{
	AIStyleParser parser = nullptr;
	if (sAIArtStyleParser->NewParser(&parser)) return 0;
	AIArtStyleHandle style = nullptr;
	AIParserLiveEffect e = nullptr;
	int n = 0;
	FindGlass(parser, art, effect, &style, &e, &n);
	sAIArtStyleParser->DisposeParser(parser);
	return n;
}

static bool HasGlass(AIArtHandle art, AILiveEffectHandle effect) { return CountGlass(art, effect) > 0; }

// Opens the settings for `art`'s glass, as a double-click in the Appearance panel would. Going through
// Illustrator keeps undo and the Appearance panel in step; the re-run also re-reads the background.
static bool EditGlass(AIArtHandle art, AILiveEffectHandle effect)
{
	AIStyleParser parser = nullptr;
	if (sAIArtStyleParser->NewParser(&parser)) return false;
	AIArtStyleHandle style = nullptr;
	AIParserLiveEffect e = nullptr;
	bool hit = FindGlass(parser, art, effect, &style, &e);
	if (hit) {
		sAIMatchingArt->DeselectAll(); // the edit applies to everything selected
		sAIArt->SetArtUserAttr(art, kArtSelected, kArtSelected);
		sAIArtStyleParser->EditEffectParameters(style, e);
	}
	sAIArtStyleParser->DisposeParser(parser);
	return hit;
}

// Re-runs every glass in the document, so each one re-reads what is behind it now.
static void RefreshAll(AILiveEffectHandle effect)
{
	AIMatchingArtSpec spec(kAnyArt, 0, 0);
	AIArtHandle** matches = nullptr;
	ai::int32 count = 0;
	if (sAIMatchingArt->GetMatchingArt(&spec, 1, &matches, &count) || !matches) return;
	for (ai::int32 i = 0; i < count; i++)
		if (HasGlass((*matches)[i], effect)) sAIArt->MarkDirty((*matches)[i], true);
	sAIMdMemory->MdMemoryDisposeHandle((AIMdMemoryHandle)matches);
	sAIDocument->RedrawDocument();
}

// Diagnostics for bug reports: %APPDATA%\Sudo Liquid Glass\log.txt, restarted when it passes 256 KB.
static void Log(const char* fmt, ...)
{
	const char* appdata = getenv("APPDATA");
	if (!appdata) return;
	std::string dir = std::string(appdata) + "\\Sudo Liquid Glass", path = dir + "\\log.txt";
	CreateDirectoryA(dir.c_str(), nullptr);
	FILE* f = _fsopen(path.c_str(), "ab", _SH_DENYNO); // plain fopen is redefined by the SDK headers
	if (f && ftell(f) > 256 * 1024) fclose(f), f = _fsopen(path.c_str(), "wb", _SH_DENYNO);
	if (!f) return;
	SYSTEMTIME t;
	GetLocalTime(&t);
	fprintf(f, "%04d-%02d-%02d %02d:%02d:%02d  ", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
	va_list a;
	va_start(a, fmt);
	vfprintf(f, fmt, a);
	va_end(a);
	fputs("\r\n", f);
	fclose(f);
}

static void Alert(const wchar_t* text, UINT icon = MB_ICONINFORMATION)
{
	AIWindowRef parent = nullptr;
	sAIAppContext->GetPlatformAppWindow(&parent);
	MessageBoxW(HWND(parent), text, L"Sudo Liquid Glass", icon | MB_OK);
}

static short ArtType(AIArtHandle a)
{
	short t = kUnknownArt;
	sAIArt->GetArtType(a, &t);
	return t;
}

static bool HasImage(AIArtHandle a)
{
	short t = ArtType(a);
	if (t == kRasterArt || t == kPlacedArt) return true;
	AIArtHandle c = nullptr;
	for (sAIArt->GetArtFirstChild(a, &c); c; sAIArt->GetArtSibling(c, &c))
		if (HasImage(c)) return true;
	return false;
}

// Why Liquid Glass can't go on `art`, in plain words, or null when it can. `allowed` = copies it may already carry
// (1 while Illustrator is adding a new one, which can already be in the appearance).
static const wchar_t* Refusal(AIArtHandle art, AILiveEffectHandle effect, int allowed = 0)
{
	short t = ArtType(art);
	if (t == kRasterArt || t == kPlacedArt)
		return L"This is a pixel image (a photo or other raster). Liquid Glass needs a vector shape or text, because it "
			L"follows the shape's edge.\n\nTip: draw a shape on top of the image and apply Liquid Glass to the shape. "
			L"The image shows through the glass.";
	if (HasImage(art))
		return L"This group contains a pixel image. Inside a glass, an image would turn into a hard-edged rectangle "
			L"of glass.\n\nTip: keep images outside the group, below the glass. They'll show through it.";
	if (CountGlass(art, effect) > allowed)
		return L"This object already has Liquid Glass. A second copy would only slow Illustrator down.\n\n"
			L"To change it: double-click Liquid Glass in the Appearance panel, or use Object > Edit Liquid Glass...";
	return nullptr;
}

class LiquidGlassPlugin : public Plugin {
public:
	LiquidGlassPlugin(SPPluginRef ref) : Plugin(ref) { strncpy(fPluginName, "LiquidGlass", kMaxStringLength); }
	FIXUP_VTABLE_EX(LiquidGlassPlugin, Plugin);

protected:
	ASErr Message(char* caller, char* selector, void* message) override
	{
		ASErr error = kNoErr;
		try {
			error = Plugin::Message(caller, selector, message);
		} catch (ai::Error& ex) {
			error = ex;
		} catch (...) {
			error = kCantHappenErr;
		}
		if (error == kUnhandledMsgErr) error = kNoErr;
		return error;
	}

	ASErr StartupPlugin(SPInterfaceMessage* message) override
	{
		ASErr e = Plugin::StartupPlugin(message);
		if (e) return e;
		if (lg_param_count() != kParamCount) return kCantHappenErr; // engine and plug-in built from different versions
		e = sAINotifier->AddNotifier(message->d.self, "LiquidGlass", kAIDocumentChangedNotifier, &fChanged);
		AIPlatformAddMenuItemDataUS edit{ kObjectUtilsMenuGroup, ai::UnicodeString("Edit Liquid Glass...") };
		AIPlatformAddMenuItemDataUS refresh{ kObjectUtilsMenuGroup, ai::UnicodeString("Refresh All Liquid Glass") };
		if (!e) e = sAIMenu->AddMenuItem(message->d.self, "LiquidGlassEdit", &edit, kMenuItemNoOptions, &fEditItem);
		if (!e) e = sAIMenu->AddMenuItem(message->d.self, "LiquidGlassRefresh", &refresh, kMenuItemNoOptions, &fRefreshItem);
		if (e) return e;
		AILiveEffectData d;
		d.self = message->d.self;
		d.name = "LiquidGlass";
		d.title = (char*)"Liquid Glass";
		d.majorVersion = 1;
		d.minorVersion = 0;
		// Strokes arrive outlined, so a stroke (variable-width profiles included) becomes part of the glass shape.
		d.prefersAsInput = kGroupInputArt | kPathInputArt | kCompoundPathInputArt | kOutlinedStrokeInputArt;
		d.styleFilterFlags = kPostEffectFilter;
		e = sAILiveEffect->AddLiveEffect(&d, &fEffect);
		if (e) return e;
		AddLiveEffectMenuData menu;
		menu.category = (char*)"Stylize";
		menu.title = (char*)"Liquid Glass...";
		menu.options = 0;
		AIMenuItemHandle item = nullptr;
		e = sAILiveEffect->AddLiveEffectMenuItem(fEffect, "LiquidGlass", &menu, &item, nullptr);
		Log("started %s (error %d)", kVersion, int(e));
		return e;
	}

	ASErr GoLiveEffect(AILiveEffectGoMessage* msg) override { return RenderGlass(msg); }

	ASErr Notify(AINotifierMessage* msg) override
	{
		if (msg->notifier == fChanged) BackdropChanged();
		return Plugin::Notify(msg);
	}

	AIArtHandle SelectedGlass()
	{
		AIArtHandle** matches = nullptr;
		ai::int32 count = 0;
		AIArtHandle glass = nullptr;
		if (!sAIMatchingArt->GetSelectedArt(&matches, &count) && matches) {
			for (ai::int32 i = 0; i < count && !glass; i++)
				for (AIArtHandle a = (*matches)[i], parent = nullptr; a && !glass; a = sAIArt->GetArtParent(a, &parent) ? nullptr : parent)
					if (HasGlass(a, fEffect)) glass = a;
			sAIMdMemory->MdMemoryDisposeHandle((AIMdMemoryHandle)matches);
		}
		return glass;
	}

	ASErr GoMenuItem(AIMenuMessage* msg) override
	{
		if (msg->menuItem == fRefreshItem) {
			RefreshAll(fEffect);
		} else if (msg->menuItem == fEditItem) {
			if (AIArtHandle glass = SelectedGlass()) EditGlass(glass, fEffect);
			else Alert(L"Select an object that has Liquid Glass first.\n\nTo add it: Effect > Stylize > Liquid Glass...");
		}
		return kNoErr;
	}

	ASErr EditLiveEffectParameters(AILiveEffectEditParamMessage* msg) override
	{
		float p[kParamCount], orig[kParamCount];
		ReadParams(msg->parameters, p);
		if (msg->isNewInstance) {
			// Applying from the Effect menu: stop the things that can't work, with the reason.
			AIArtHandle** matches = nullptr;
			ai::int32 count = 0;
			const wchar_t* why = nullptr;
			if (!sAIMatchingArt->GetSelectedArt(&matches, &count) && matches) {
				for (ai::int32 i = 0; i < count && !why; i++) {
					AIArtHandle a = (*matches)[i], parent = nullptr;
					ASBoolean layer = false;
					if (!sAIArt->GetArtParent(a, &parent) && parent) sAIArt->IsArtLayerGroup(parent, &layer);
					if (layer) why = Refusal(a, fEffect, 1); // whole objects only, not the parts of a selected group
				}
				sAIMdMemory->MdMemoryDisposeHandle((AIMdMemoryHandle)matches);
			}
			if (why) {
				Log("apply refused");
				Alert(why);
				return kCanceledErr;
			}
			ai::int16 model = 0;
			static bool warned = false;
			if (!warned && !sAIDocument->GetDocumentColorModel(&model) && model == kDocCMYKColor) {
				warned = true;
				Alert(L"This is a CMYK document. Liquid Glass is worked out in RGB, so its colours can shift a little "
					L"when printed. For screen work, use an RGB document (File > Document Color Mode > RGB).",
					MB_ICONWARNING);
			}
			AutoSize(p);
		}
		memcpy(orig, p, sizeof p);
		AIDocumentSetup setup;
		float docW = sAIDocument->GetDocumentSetup(&setup) ? 612.f : float(setup.width);
		DialogHost host;
		AIWindowRef parent = nullptr;
		sAIAppContext->GetPlatformAppWindow(&parent);
		host.parent = parent;
		host.docWidthPt = docW;
		host.allowPreview = msg->allowPreview != 0;
		host.ctx = msg;
		host.preview = [](const float* q, void* c) {
			auto m = (AILiveEffectEditParamMessage*)c;
			WriteParams(m->parameters, q);
			sAILiveEffect->UpdateParameters(m->context);
			sAIDocument->RedrawDocument();
		};
		// A changing counter makes the parameters differ, so Illustrator re-runs the effect even with the same settings.
		host.refresh = [](const float* q, void* c) {
			static ai::int32 seq = 0;
			auto m = (AILiveEffectEditParamMessage*)c;
			WriteParams(m->parameters, q);
			sAIDictionary->SetIntegerEntry(m->parameters, sAIDictionary->Key("lgRefresh"), ++seq);
			sAILiveEffect->UpdateParameters(m->context);
			sAIDocument->RedrawDocument();
		};
		bool ok = RunDialog(p, host);
		WriteParams(msg->parameters, ok ? p : orig);
		sAILiveEffect->UpdateParameters(msg->context);
		return ok ? kNoErr : kCanceledErr;
	}

private:
	AILiveEffectHandle fEffect = nullptr;
	AINotifierHandle fChanged = nullptr;
	AIMenuItemHandle fEditItem = nullptr, fRefreshItem = nullptr;

	// Rim width and blur scale with the selection's short side (25% and 6%), so big shapes look like small ones.
	static void AutoSize(float* p)
	{
		AIArtHandle** matches = nullptr;
		ai::int32 count = 0;
		if (!sAIMatchingArt->GetSelectedArt(&matches, &count) && matches) {
			AIRealRect u{};
			for (ai::int32 i = 0; i < count; i++) {
				AIRealRect b;
				if (sAIArt->GetArtBounds((*matches)[i], &b)) continue;
				if (!i) u = b;
				else {
					u.left = std::min(u.left, b.left);
					u.right = std::max(u.right, b.right);
					u.top = std::max(u.top, b.top);
					u.bottom = std::min(u.bottom, b.bottom);
				}
			}
			float s = float(std::min(u.right - u.left, u.top - u.bottom));
			if (count) {
				p[kDepth] = std::round(std::min(200.f, std::max(8.f, 0.25f * s)));
				if (p[kFrost] > 0) p[kFrost] = std::round(std::min(200.f, std::max(8.f, 0.06f * s)));
			}
			sAIMdMemory->MdMemoryDisposeHandle((AIMdMemoryHandle)matches);
		}
	}
};

Plugin* AllocatePlugin(SPPluginRef pluginRef) { return new LiquidGlassPlugin(pluginRef); }
void FixupReload(Plugin* plugin) { LiquidGlassPlugin::FixupVTable((LiquidGlassPlugin*)plugin); }
