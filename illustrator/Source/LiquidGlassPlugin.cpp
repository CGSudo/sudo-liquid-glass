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
#include <ctime>
#include <filesystem>
#include <fstream>
#include <sstream>
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

// Diagnostics for bug reports, restarted when it passes 256 KB:
// Windows %APPDATA%\Sudo Liquid Glass\log.txt, macOS ~/Library/Logs/Sudo Liquid Glass.log.
static void Log(const char* fmt, ...)
{
#ifdef WIN_ENV
	const char* base = getenv("APPDATA");
	const char* rel = "/Sudo Liquid Glass/log.txt";
#else
	const char* base = getenv("HOME");
	const char* rel = "/Library/Logs/Sudo Liquid Glass.log";
#endif
	if (!base) return;
	std::error_code ec;
	std::filesystem::path path = std::filesystem::u8path(std::string(base) + rel);
	std::filesystem::create_directories(path.parent_path(), ec);
	bool restart = std::filesystem::exists(path, ec) && std::filesystem::file_size(path, ec) > 256 * 1024;
	std::ofstream f(path, restart ? std::ios::trunc : std::ios::app);
	if (!f) return;
	char when[32], text[512];
	std::time_t now = std::time(nullptr);
	std::strftime(when, sizeof when, "%Y-%m-%d %H:%M:%S", std::localtime(&now));
	va_list a;
	va_start(a, fmt);
	vsnprintf(text, sizeof text, fmt, a);
	va_end(a);
	f << when << "  " << text << "\n";
}

static void Alert(const char* text) { sAIUser->MessageAlert(ai::UnicodeString::FromUTF8(text)); }

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
static const char* Refusal(AIArtHandle art, AILiveEffectHandle effect, int allowed = 0)
{
	short t = ArtType(art);
	if (t == kRasterArt || t == kPlacedArt)
		return "This is a pixel image (a photo or other raster). Liquid Glass needs a vector shape or text, because it "
			"follows the shape's edge.\n\nTip: draw a shape on top of the image and make the shape glass. "
			"The image shows through the glass.";
	if (HasImage(art))
		return "This group contains a pixel image. Inside a glass, an image would turn into a hard-edged rectangle "
			"of glass.\n\nTip: keep images outside the group, below the glass. They'll show through it.";
	if (CountGlass(art, effect) > allowed)
		return "This object already has Liquid Glass. A second copy would only slow Illustrator down.\n\n"
			"Change it in the Sudo Liquid Glass panel instead.";
	return nullptr;
}

// Whole selected objects (not the parts of a selected group), top first.
static std::vector<AIArtHandle> SelectedObjects()
{
	std::vector<AIArtHandle> out;
	AIArtHandle** matches = nullptr;
	ai::int32 count = 0;
	if (!sAIMatchingArt->GetSelectedArt(&matches, &count) && matches) {
		for (ai::int32 i = 0; i < count; i++) {
			AIArtHandle a = (*matches)[i], parent = nullptr;
			ASBoolean layer = false;
			if (!sAIArt->GetArtParent(a, &parent) && parent) sAIArt->IsArtLayerGroup(parent, &layer);
			if (layer) out.push_back(a);
		}
		sAIMdMemory->MdMemoryDisposeHandle((AIMdMemoryHandle)matches);
	}
	return out;
}

// The glass on a selected object, or on a group around a selected part.
static std::vector<AIArtHandle> SelectedGlasses(AILiveEffectHandle effect)
{
	std::vector<AIArtHandle> out;
	AIArtHandle** matches = nullptr;
	ai::int32 count = 0;
	if (!sAIMatchingArt->GetSelectedArt(&matches, &count) && matches) {
		for (ai::int32 i = 0; i < count; i++)
			for (AIArtHandle a = (*matches)[i], parent = nullptr; a; a = sAIArt->GetArtParent(a, &parent) ? nullptr : parent)
				if (HasGlass(a, effect)) {
					if (std::find(out.begin(), out.end(), a) == out.end()) out.push_back(a);
					break;
				}
		sAIMdMemory->MdMemoryDisposeHandle((AIMdMemoryHandle)matches);
	}
	return out;
}

static bool GlassParams(AIArtHandle art, AILiveEffectHandle effect, float* p)
{
	AIStyleParser parser = nullptr;
	if (sAIArtStyleParser->NewParser(&parser)) return false;
	AIArtStyleHandle style = nullptr;
	AIParserLiveEffect e = nullptr;
	AILiveEffectParameters d = nullptr;
	bool ok = FindGlass(parser, art, effect, &style, &e) && !sAIArtStyleParser->GetLiveEffectParams(e, &d);
	if (ok) ReadParams(d, p);
	sAIArtStyleParser->DisposeParser(parser);
	return ok;
}

// New appearance for `art` with the glass settings replaced (one undo step, like any appearance edit).
static AIErr SetGlassParams(AIArtHandle art, AILiveEffectHandle effect, const float* p)
{
	AIStyleParser parser = nullptr;
	AIErr e = sAIArtStyleParser->NewParser(&parser);
	if (e) return e;
	AIArtStyleHandle style = nullptr, next = nullptr;
	AIParserLiveEffect le = nullptr;
	AILiveEffectParameters d = nullptr;
	if (!FindGlass(parser, art, effect, &style, &le)) e = kBadParameterErr;
	if (!e) e = sAILiveEffect->CreateLiveEffectParameters(&d);
	if (!e) {
		WriteParams(d, p);
		e = sAIArtStyleParser->SetLiveEffectParams(le, d);
	}
	if (!e) e = sAIArtStyleParser->CreateNewStyle(parser, &next);
	if (!e) e = sAIArtStyle->SetArtStyle(art, next);
	if (d) sAIDictionary->Release(d);
	sAIArtStyleParser->DisposeParser(parser);
	return e;
}

static AIErr ApplyGlass(AIArtHandle art, AILiveEffectHandle effect, const float* p)
{
	AILiveEffectParameters d = nullptr;
	AIErr e = sAILiveEffect->CreateLiveEffectParameters(&d);
	if (e) return e;
	WriteParams(d, p);
	AIStyleParser parser = nullptr;
	AIArtStyleHandle style = nullptr, glassy = nullptr;
	AIParserLiveEffect le = nullptr;
	e = sAIArtStyleParser->NewParser(&parser);
	if (!e) e = sAIArtStyle->GetArtStyle(art, &style);
	if (!e) e = sAIArtStyleParser->ParseStyle(parser, style);
	if (!e) e = sAIArtStyleParser->NewParserLiveEffect(effect, d, &le);
	if (!e) e = sAIArtStyleParser->InsertNthPostEffect(parser, sAIArtStyleParser->CountPostEffects(parser), le);
	if (!e) e = sAIArtStyleParser->CreateNewStyle(parser, &glassy);
	if (!e) e = sAIArtStyle->SetArtStyle(art, glassy);
	if (parser) sAIArtStyleParser->DisposeParser(parser);
	sAIDictionary->Release(d);
	return e;
}

// "1,2,3" from the panel -> exactly kParamCount finite numbers, or false.
static bool ParseCsv(const std::string& s, float* out)
{
	const char* c = s.c_str();
	for (int i = 0; i < kParamCount; i++) {
		char* end = nullptr;
		double v = strtod(c, &end);
		if (end == c || !std::isfinite(v) || std::fabs(v) > 1e6) return false;
		out[i] = float(v);
		c = end;
		if (i < kParamCount - 1 && *c++ != ',') return false;
	}
	return *c == 0;
}

static void WarnIfCMYK()
{
	ai::int16 model = 0;
	static bool warned = false;
	if (!warned && !sAIDocument->GetDocumentColorModel(&model) && model == kDocCMYKColor) {
		warned = true;
		Alert("This is a CMYK document. Liquid Glass is worked out in RGB, so its colours can shift a little when "
			"printed. For screen work, use an RGB document (File > Document Color Mode > RGB).");
	}
}

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

static const char* kPanelId = "com.cgsudo.liquidglass.panel"; // = illustrator/cep/CSXS/manifest.xml

class LiquidGlassPlugin : public Plugin {
public:
	LiquidGlassPlugin(SPPluginRef ref) : Plugin(ref) { strncpy(fPluginName, "LiquidGlass", kMaxStringLength); }
	FIXUP_VTABLE_EX(LiquidGlassPlugin, Plugin);

protected:
	ASErr Message(char* caller, char* selector, void* message) override
	{
		ASErr error = kNoErr;
		try {
			// The panel (CEP) talks to the plug-in through app.sendScriptMessage("LiquidGlass", selector, input).
			if (!strcmp(caller, kCallerAIScriptMessage)) error = Script(selector, (AIScriptMessage*)message);
			else error = Plugin::Message(caller, selector, message);
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
		AIPlatformAddMenuItemDataUS edit{ kObjectUtilsMenuGroup, ai::UnicodeString("Sudo Liquid Glass Panel") };
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
		menu.title = (char*)"Liquid Glass";
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

	ASErr GoMenuItem(AIMenuMessage* msg) override
	{
		if (msg->menuItem == fRefreshItem) RefreshAll(fEffect);
		else if (msg->menuItem == fEditItem) OpenPanel();
		return kNoErr;
	}

	// Effect > Stylize > Liquid Glass applies at once (sized to the shape); settings live in the panel, which opens.
	// Double-clicking the effect in the Appearance panel opens the panel too.
	ASErr EditLiveEffectParameters(AILiveEffectEditParamMessage* msg) override
	{
		if (!msg->isNewInstance) {
			OpenPanel();
			return kCanceledErr; // nothing changed here; the panel edits the glass
		}
		for (AIArtHandle a : SelectedObjects())
			if (const char* why = Refusal(a, fEffect, 1)) {
				Log("apply refused");
				Alert(why);
				return kCanceledErr;
			}
		WarnIfCMYK();
		float p[kParamCount];
		ReadParams(msg->parameters, p);
		AutoSize(p);
		WriteParams(msg->parameters, p);
		OpenPanel();
		return kNoErr;
	}

private:
	AILiveEffectHandle fEffect = nullptr;
	AINotifierHandle fChanged = nullptr;
	AIMenuItemHandle fEditItem = nullptr, fRefreshItem = nullptr;
	SDKPlugPlug fPlugPlug;
	bool fPlugPlugLoaded = false;

	void OpenPanel()
	{
		if (!fPlugPlugLoaded) fPlugPlugLoaded = !fPlugPlug.Load(sAIFolders);
		int e = fPlugPlugLoaded ? int(fPlugPlug.LoadExtension(kPanelId)) : -1;
		Log("open panel (result %d)", e);
		if (e) Alert("The Sudo Liquid Glass panel isn't installed. Install SudoLiquidGlassPanel.zxp from the download, "
			"then open it from Window > Extensions > Sudo Liquid Glass.");
	}

	ASErr Script(const char* sel, AIScriptMessage* m)
	{
		std::string in = m->inParam.as_UTF8(), out;
		float p[kParamCount];
		if (!strcmp(sel, "state")) out = State();
		else if (!strcmp(sel, "apply")) out = ParseCsv(in, p) ? Apply(p) : "Those settings weren't readable.";
		else if (!strcmp(sel, "make")) out = ParseCsv(in, p) ? Make(p) : "Those settings weren't readable.";
		else if (!strcmp(sel, "refresh")) {
			RefreshAll(fEffect);
			out = "Every glass re-read what's behind it.";
		}
		m->outParam = ai::UnicodeString::FromUTF8(out);
		return kNoErr;
	}

	// For the panel: {"doc":0|1,"n":selected objects,"glass":glasses selected,"w":doc width pt,"p":[settings]|null}.
	std::string State()
	{
		AIDocumentHandle doc = nullptr;
		if (sAIDocument->GetDocument(&doc) || !doc) return "{\"doc\":0}";
		AIDocumentSetup setup;
		float w = sAIDocument->GetDocumentSetup(&setup) ? 612.f : float(setup.width);
		std::vector<AIArtHandle> glasses = SelectedGlasses(fEffect);
		std::ostringstream o;
		o << "{\"doc\":1,\"n\":" << SelectedObjects().size() << ",\"glass\":" << glasses.size() << ",\"w\":" << w << ",\"p\":";
		float p[kParamCount];
		if (!glasses.empty() && GlassParams(glasses[0], fEffect, p)) {
			o << "[";
			for (int i = 0; i < kParamCount; i++) o << (i ? "," : "") << p[i];
			o << "]";
		} else o << "null";
		o << "}";
		return o.str();
	}

	std::string Apply(const float* p)
	{
		std::vector<AIArtHandle> glasses = SelectedGlasses(fEffect);
		if (glasses.empty()) return "";
		sAIUndo->SetUndoTextUS(ai::UnicodeString("Undo Liquid Glass"), ai::UnicodeString("Redo Liquid Glass"));
		for (AIArtHandle g : glasses) SetGlassParams(g, fEffect, p);
		return "";
	}

	// Make Glass: the selected objects become one glass (several objects are grouped first, so they melt together).
	std::string Make(const float* settings)
	{
		std::vector<AIArtHandle> sel = SelectedObjects();
		if (sel.empty()) return "Select a shape, group or text first.";
		for (AIArtHandle a : sel)
			if (const char* why = Refusal(a, fEffect)) return why;
		WarnIfCMYK();
		float p[kParamCount];
		memcpy(p, settings, sizeof p);
		AutoSize(p);
		AIArtHandle target = sel[0];
		if (sel.size() > 1) {
			AIErr e = sAIArt->NewArt(kGroupArt, kPlaceAbove, sel[0], &target);
			for (AIArtHandle a : sel)
				if (!e) e = sAIArt->ReorderArt(a, kPlaceInsideOnBottom, target);
			if (e) return "Couldn't group the selected objects.";
		}
		sAIUndo->SetUndoTextUS(ai::UnicodeString("Undo Make Glass"), ai::UnicodeString("Redo Make Glass"));
		AIErr e = ApplyGlass(target, fEffect, p);
		Log("make glass from %d objects (error %d)", int(sel.size()), int(e));
		if (e) return "Illustrator didn't accept the glass on this object.";
		sAIMatchingArt->DeselectAll();
		sAIArt->SetArtUserAttr(target, kArtSelected, kArtSelected);
		return sel.size() > 1 ? "Done: the objects are grouped and melt together as one glass." : "Done.";
	}
};

Plugin* AllocatePlugin(SPPluginRef pluginRef) { return new LiquidGlassPlugin(pluginRef); }
void FixupReload(Plugin* plugin) { LiquidGlassPlugin::FixupVTable((LiquidGlassPlugin*)plugin); }
