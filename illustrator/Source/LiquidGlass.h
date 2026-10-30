// Liquid Glass Live Effect for Illustrator: shared declarations.
#pragma once
#include "IllustratorSDK.h"
#include "AILiveEffect.h"
#include "AIRasterize.h"
#include "AIRaster.h"
#include "AIArtSet.h"
#include "AILayer.h"
#include "AIDictionary.h"
#include "AIMatchingArt.h"
#include "AIMdMemory.h"
#include "AIDocument.h"
#include "AIMenu.h"
#include "AIUnicodeString.h"
#include "SPBlocks.h"
#include "Plugin.hpp"
#include "Suites.hpp"

extern "C" AILiveEffectSuite* sAILiveEffect;
extern "C" AIDictionarySuite* sAIDictionary;
extern "C" AIArtSuite* sAIArt;
extern "C" AIArtSetSuite* sAIArtSet;
extern "C" AIRasterizeSuite* sAIRasterize;
extern "C" AIRasterSuite* sAIRaster;
extern "C" AILayerSuite* sAILayer;
extern "C" AIMatchingArtSuite* sAIMatchingArt;
extern "C" AIMdMemorySuite* sAIMdMemory;
extern "C" AIDocumentSuite* sAIDocument;
extern "C" AIMenuSuite* sAIMenu;
extern "C" AIUnicodeStringSuite* sAIUnicodeString;
extern "C" SPBlocksSuite* sSPBlocks;

#include "AIArtStyle.h"
#include "AIArtStyleParser.h"
#include "AIScriptMessage.h"
#include "AIUndo.h"
#include "SDKPlugPlug.h"

constexpr const char* kVersion = "0.8.0";

// Order = glass_core::Params (photoshop/looks.js DEFAULTS). Lengths (kLengths) are in pt here, px at render.
constexpr int kParamCount = 42;
extern const float kDefaults[kParamCount];
enum { kAngle = 0, kDepth = 3, kFrost = 5, kGrain = 16, kGrainSize = 17, kDim = 18 };

extern "C" AIArtStyleSuite* sAIArtStyle;
extern "C" AIArtStyleParserSuite* sAIArtStyleParser;
extern "C" AIUndoSuite* sAIUndo;


extern "C" unsigned lg_param_count();
extern "C" int lg_render(const float* p, const unsigned char* backdrop, const unsigned char* masks, unsigned n_masks,
	unsigned w, unsigned h, unsigned char* out, unsigned char* under);
