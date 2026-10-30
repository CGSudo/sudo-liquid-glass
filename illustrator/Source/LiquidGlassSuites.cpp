#include "LiquidGlass.h"

extern "C" {
	AILiveEffectSuite* sAILiveEffect = nullptr;
	AIDictionarySuite* sAIDictionary = nullptr;
	AIArtSuite* sAIArt = nullptr;
	AIArtSetSuite* sAIArtSet = nullptr;
	AIRasterizeSuite* sAIRasterize = nullptr;
	AIRasterSuite* sAIRaster = nullptr;
	AILayerSuite* sAILayer = nullptr;
	AIMatchingArtSuite* sAIMatchingArt = nullptr;
	AIMdMemorySuite* sAIMdMemory = nullptr;
	AIDocumentSuite* sAIDocument = nullptr;
	AIMenuSuite* sAIMenu = nullptr;
	AIUnicodeStringSuite* sAIUnicodeString = nullptr;
	SPBlocksSuite* sSPBlocks = nullptr;
	AIArtStyleSuite* sAIArtStyle = nullptr;
	AIArtStyleParserSuite* sAIArtStyleParser = nullptr;
	AIUndoSuite* sAIUndo = nullptr;
}

ImportSuite gImportSuites[] = {
	kAILiveEffectSuite, kAILiveEffectVersion, &sAILiveEffect,
	kAIDictionarySuite, kAIDictionaryVersion, &sAIDictionary,
	kAIArtSuite, kAIArtVersion, &sAIArt,
	kAIArtSetSuite, kAIArtSetVersion, &sAIArtSet,
	kAIRasterizeSuite, kAIRasterizeVersion, &sAIRasterize,
	kAIRasterSuite, kAIRasterVersion, &sAIRaster,
	kAILayerSuite, kAILayerVersion, &sAILayer,
	kAIMatchingArtSuite, kAIMatchingArtVersion, &sAIMatchingArt,
	kAIMdMemorySuite, kAIMdMemoryVersion, &sAIMdMemory,
	kAIDocumentSuite, kAIDocumentVersion, &sAIDocument,
	kAIMenuSuite, kAIMenuVersion, &sAIMenu,
	kAIUnicodeStringSuite, kAIUnicodeStringVersion, &sAIUnicodeString,
	kSPBlocksSuite, kSPBlocksSuiteVersion, &sSPBlocks,
	kAIArtStyleSuite, kAIArtStyleVersion, &sAIArtStyle,
	kAIArtStyleParserSuite, kAIArtStyleParserVersion, &sAIArtStyleParser,
	kAIUndoSuite, kAIUndoVersion, &sAIUndo,
	nullptr, 0, nullptr
};
