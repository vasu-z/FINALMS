import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions, PermissionResponse } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../theme/colors";
import { speechService } from "../services/speech";
import { hapticsService } from "../services/haptics";
import { readTextOcr, ReadTextOcrResponse } from "../api/client";
import { ocrService } from "../services/ocr";

function hasNativeModule(name: string): boolean {
  try {
    const g = globalThis as any;
    if (g?.expo?.modules?.[name]) return true;
    if (g?.nativeModuleProxy?.[name]) return true;
    if (g?.__turboModuleProxy && g.__turboModuleProxy(name)) return true;
  } catch {
    // Safe ignore
  }
  return false;
}

async function safeCopyText(text: string): Promise<void> {
  try {
    if (process.env.NODE_ENV === "test" || hasNativeModule("ExpoClipboard")) {
      const Clipboard = await import("expo-clipboard");
      if (Clipboard && typeof Clipboard.setStringAsync === "function") {
        await Clipboard.setStringAsync(text);
        return;
      }
    }
  } catch {
    // Safe ignore
  }
}

export type OcrMode = "fast" | "balanced" | "accurate";

export interface OcrReaderScreenProps {
  onNavigateBack: () => void;
  permissionResponse?: PermissionResponse | null;
  onRequestPermission?: () => Promise<PermissionResponse>;
}

export const OcrReaderScreen: React.FC<OcrReaderScreenProps> = ({
  onNavigateBack,
  permissionResponse: propPermission,
  onRequestPermission: propRequestPermission,
}) => {
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraView>(null);

  const [hookPermission, hookRequestPermission] = useCameraPermissions();
  const permission = propPermission !== undefined ? propPermission : hookPermission;
  const requestPermission = propRequestPermission || hookRequestPermission;

  const [mode, setMode] = useState<OcrMode>("balanced");
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [processingStage, setProcessingStage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCameraReady, setIsCameraReady] = useState<boolean>(false);
  const [ocrResult, setOcrResult] = useState<ReadTextOcrResponse | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<boolean>(false);

  const isCapturingRef = useRef<boolean>(false);
  const hasAnnouncedStartupRef = useRef<boolean>(false);

  // Spoken guidance on screen entry
  useEffect(() => {
    if (hasAnnouncedStartupRef.current) return;
    hasAnnouncedStartupRef.current = true;

    (async () => {
      const welcome =
        "Read Anything active. Point your camera steady at lecture notes, handwritten formulas, or printed text. Tap anywhere to read verbatim.";
      await speechService.speak(welcome, { force: true });
    })();
  }, []);

  // Safe navigation back to Home
  const handleBack = async () => {
    await hapticsService.triggerBottomLeft();
    await speechService.stop();
    onNavigateBack();
  };

  // Switch OCR mode
  const handleSelectMode = async (newMode: OcrMode) => {
    if (newMode === mode) return;
    await hapticsService.triggerButtonPress();
    setMode(newMode);
    const modeName =
      newMode === "fast"
        ? "Fast mode"
        : newMode === "accurate"
        ? "Accurate mode for math and handwriting"
        : "Balanced mode";
    await speechService.speak(`${modeName} selected.`, { force: true });
  };

  // Spoken instructions replay
  const handleAnnounceInstructions = async () => {
    await hapticsService.triggerButtonPress();
    const instructions =
      "Read Anything. Transcribes notes, handwriting, mathematical equations, and printed documents verbatim. Select Fast, Balanced, or Accurate mode at the top. Tap anywhere on the camera view or press the Read Notes button to capture.";
    await speechService.speak(instructions, { force: true });
  };

  // Capture & OCR pipeline
  const executeCapture = useCallback(async () => {
    if (isCapturingRef.current || isCapturing) {
      return;
    }

    if (!permission?.granted) {
      await speechService.speak("Camera permission is required to scan notes.", { force: true });
      return;
    }

    if (!cameraRef.current) {
      await speechService.speak("Camera is initializing, please hold steady.", { force: true });
      return;
    }

    try {
      isCapturingRef.current = true;
      setIsCapturing(true);
      setErrorMessage(null);
      setProcessingStage("Capturing image...");
      await hapticsService.triggerCapture();

      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.92,
        skipProcessing: false,
      });

      if (!photo || !photo.uri) {
        throw new Error("Camera did not return a valid photo.");
      }

      setProcessingStage(`Reading text in ${mode} mode...`);
      await speechService.speak(`Image captured. Reading in ${mode} mode...`, { force: true });

      let result: ReadTextOcrResponse;
      try {
        if (!photo.base64) {
          throw new Error("Base64 photo data unavailable.");
        }
        result = await readTextOcr(photo.base64, mode, "image/jpeg");
      } catch (backendErr: any) {
        console.warn("[OcrReaderScreen] Backend OCR failed, attempting local fallback:", backendErr);
        // Fallback to local on-device ML Kit OCR
        const localOcr = await ocrService.recognizeTextFromUri(photo.uri);
        if (localOcr && localOcr.text && localOcr.text.trim()) {
          result = {
            text: localOcr.text,
            mode,
            confidence: localOcr.confidence,
            has_math: false,
            reading_order_blocks: localOcr.blocks,
            model: "on-device-mlkit",
          };
        } else {
          throw backendErr;
        }
      }

      setIsCapturing(false);
      isCapturingRef.current = false;
      setProcessingStage("");
      setOcrResult(result);

      // Read recognized text aloud
      await hapticsService.triggerSuccess();
      const speakIntro = result.has_math
        ? "Transcribed notes with mathematical equations: "
        : "Transcribed text: ";
      await speechService.speak(`${speakIntro}${result.text}`, { force: true });
    } catch (err: any) {
      setIsCapturing(false);
      isCapturingRef.current = false;
      setProcessingStage("");
      const userErr = "Could not read text clearly. Please hold your phone steady with good lighting and try again.";
      setErrorMessage(userErr);
      await hapticsService.triggerError();
      await speechService.speak(userErr, { force: true });
    }
  }, [isCapturing, mode, permission?.granted]);

  // Copy text to clipboard
  const handleCopyText = async () => {
    if (!ocrResult?.text) return;
    await hapticsService.triggerButtonPress();
    await safeCopyText(ocrResult.text);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2500);
    await speechService.speak("Text copied to clipboard.", { force: true });
  };

  // Replay speech
  const handleReplayText = async () => {
    if (!ocrResult?.text) return;
    await hapticsService.triggerButtonPress();
    await speechService.speak(ocrResult.text, { force: true });
  };

  // Reset to scan another document
  const handleScanAnother = async () => {
    await hapticsService.triggerButtonPress();
    setOcrResult(null);
    setErrorMessage(null);
    await speechService.speak("Ready to scan next document or notes page.", { force: true });
  };

  // Permission handling UI
  if (!permission || !permission.granted) {
    return (
      <View style={[styles.permissionContainer, { paddingTop: Math.max(insets.top, 24) }]}>
        <Ionicons name="camera-outline" size={64} color="#FB923C" />
        <Text style={styles.permissionTitle}>Camera Permission Required</Text>
        <Text style={styles.permissionBody}>
          SAARTHI needs camera access to read lecture notes, equations, and documents verbatim.
        </Text>
        <Pressable
          onPress={requestPermission}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Allow camera access"
          style={styles.permissionButton}
        >
          <Text style={styles.permissionButtonText}>Allow Camera Access</Text>
        </Pressable>
        <Pressable
          onPress={handleBack}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Go back to Home"
          style={styles.permissionCancelButton}
        >
          <Text style={styles.permissionCancelButtonText}>Cancel & Return to Home</Text>
        </Pressable>
      </View>
    );
  }

  const topInset = Math.max(insets.top, 12);
  const bottomInset = Math.max(insets.bottom, 16);

  // If we have an OCR result, render the Reading Results View
  if (ocrResult) {
    return (
      <View style={[styles.container, { paddingTop: topInset, paddingBottom: bottomInset }]}>
        {/* Results Header */}
        <View style={styles.headerBar}>
          <Pressable
            onPress={handleBack}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Back to Home Screen"
            accessibilityHint="Double tap to return to the home screen"
            style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
          >
            <Ionicons name="arrow-back" size={26} color="#FFFFFF" />
            <Text style={styles.headerButtonText}>Home</Text>
          </Pressable>

          <View style={styles.headerTitleContainer} accessible={true} accessibilityRole="header">
            <Text style={styles.headerTitle}>OCR RESULT</Text>
            <Text style={styles.headerSubtitle}>
              {ocrResult.has_math ? "Notes & Equations Transcribed" : "Verbatim Transcription"}
            </Text>
          </View>

          <Pressable
            onPress={handleScanAnother}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Scan another page"
            style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
          >
            <Ionicons name="scan-outline" size={26} color="#FFFFFF" />
            <Text style={styles.headerButtonText}>Scan</Text>
          </Pressable>
        </View>

        {/* Math & Confidence Badges */}
        <View style={styles.badgeRow}>
          {ocrResult.has_math && (
            <View style={styles.mathBadge}>
              <Ionicons name="calculator-outline" size={16} color="#FBBF24" />
              <Text style={styles.mathBadgeText}>Formulas Detected</Text>
            </View>
          )}
          <View style={styles.modeBadge}>
            <Text style={styles.modeBadgeText}>Mode: {ocrResult.mode.toUpperCase()}</Text>
          </View>
          <View style={styles.confidenceBadge}>
            <Text style={styles.confidenceBadgeText}>
              Confidence: {Math.round(ocrResult.confidence * 100)}%
            </Text>
          </View>
        </View>

        {/* Scrollable Transcribed Text View */}
        <ScrollView style={styles.resultsScrollView} contentContainerStyle={styles.resultsScrollContent}>
          <View style={styles.textCard} accessible={true} accessibilityRole="text" accessibilityLabel={ocrResult.text}>
            <Text style={styles.transcribedText}>{ocrResult.text}</Text>
          </View>
        </ScrollView>

        {/* Action Buttons: Copy, Re-read, Scan Another */}
        <View style={styles.resultsActionsContainer}>
          <View style={styles.actionRow}>
            <Pressable
              onPress={handleCopyText}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel={copyFeedback ? "Text copied to clipboard" : "Copy transcribed text"}
              accessibilityHint="Copies the full transcribed text to your phone clipboard"
              style={({ pressed }) => [
                styles.actionButton,
                styles.copyButton,
                pressed && styles.actionButtonPressed,
              ]}
            >
              <Ionicons name={copyFeedback ? "checkmark-circle" : "copy-outline"} size={24} color="#FFFFFF" />
              <Text style={styles.actionButtonText}>
                {copyFeedback ? "Copied!" : "Copy Text"}
              </Text>
            </Pressable>

            <Pressable
              onPress={handleReplayText}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Re-read text aloud"
              accessibilityHint="Speaks the transcribed text aloud again"
              style={({ pressed }) => [
                styles.actionButton,
                styles.listenButton,
                pressed && styles.actionButtonPressed,
              ]}
            >
              <Ionicons name="volume-high" size={24} color="#FFFFFF" />
              <Text style={styles.actionButtonText}>Listen Again</Text>
            </Pressable>
          </View>

          <Pressable
            onPress={handleScanAnother}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Scan another page"
            accessibilityHint="Returns to camera viewfinder to scan another notes page"
            style={({ pressed }) => [
              styles.scanAnotherButton,
              pressed && styles.actionButtonPressed,
            ]}
          >
            <Ionicons name="camera" size={26} color="#FFFFFF" />
            <Text style={styles.scanAnotherButtonText}>Scan Another Page</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // Camera Live Scanning View
  return (
    <View style={styles.container}>
      {/* 1. Live Camera View */}
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        mode="picture"
        onCameraReady={() => setIsCameraReady(true)}
      />

      {/* 2. UI Overlay */}
      <View
        style={[
          styles.screenOverlay,
          {
            paddingTop: topInset,
            paddingBottom: bottomInset,
          },
        ]}
        accessible={false}
      >
        {/* Top Header Bar */}
        <View style={styles.headerBar}>
          <Pressable
            onPress={handleBack}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Back to Home Screen"
            accessibilityHint="Double tap to return to the home screen"
            style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
          >
            <Ionicons name="arrow-back" size={26} color="#FFFFFF" />
            <Text style={styles.headerButtonText}>Back</Text>
          </Pressable>

          <View style={styles.headerTitleContainer} accessible={true} accessibilityRole="header">
            <Text style={styles.headerTitle}>READ ANYTHING</Text>
            <Text style={styles.headerSubtitle}>Universal Notes & Document Scanner</Text>
          </View>

          <Pressable
            onPress={handleAnnounceInstructions}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Help and instructions"
            accessibilityHint="Double tap to hear instructions for reading notes and formulas"
            style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
          >
            <Ionicons name="volume-high" size={26} color="#FFFFFF" />
            <Text style={styles.headerButtonText}>Help</Text>
          </Pressable>
        </View>

        {/* Mode Selector Pill Bar */}
        <View style={styles.modeSelectorBar} accessible={true} accessibilityRole="radiogroup" accessibilityLabel="OCR Reading Mode Selector">
          {(["fast", "balanced", "accurate"] as OcrMode[]).map((m) => {
            const isSelected = mode === m;
            const label =
              m === "fast"
                ? "Fast (Speed)"
                : m === "accurate"
                ? "Accurate (Math)"
                : "Balanced (Default)";
            return (
              <Pressable
                key={m}
                onPress={() => handleSelectMode(m)}
                accessible={true}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={`${label}. ${isSelected ? "Currently selected." : "Double tap to select."}`}
                style={[
                  styles.modeButton,
                  isSelected && styles.modeButtonSelected,
                ]}
              >
                <Text style={[styles.modeButtonText, isSelected && styles.modeButtonTextSelected]}>
                  {m === "fast" ? "⚡ Fast" : m === "accurate" ? "🎯 Accurate" : "⚖️ Balanced"}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Error Recovery Card */}
        {errorMessage && (
          <View style={styles.errorOverlayCard} accessible={true} accessibilityRole="alert">
            <View style={styles.errorHeaderRow}>
              <Ionicons name="alert-circle" size={22} color={Colors.error} />
              <Text style={styles.errorTitle}>Scan Incomplete</Text>
            </View>
            <Text style={styles.errorBody}>{errorMessage}</Text>
            <View style={styles.errorButtonsRow}>
              <Pressable
                onPress={() => setErrorMessage(null)}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel="Dismiss error message"
                style={styles.errorDismissButton}
              >
                <Text style={styles.errorDismissButtonText}>Dismiss</Text>
              </Pressable>
              <Pressable
                onPress={() => executeCapture()}
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel="Retry capture now"
                style={styles.errorRetryButton}
              >
                <Text style={styles.errorRetryButtonText}>Retry Scan</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Central Viewfinder Targeting Area (Tap anywhere to capture) */}
        <Pressable
          onPress={() => executeCapture()}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Camera Viewfinder. Double-tap anywhere to take a photo and read notes verbatim."
          accessibilityHint="Scans notes, handwriting, equations, or documents in front of camera"
          style={({ pressed }) => [styles.viewfinderArea, pressed && styles.viewfinderPressed]}
        >
          <View style={styles.viewfinderFrame}>
            <View style={[styles.cornerAccent, styles.topLeftCorner]} />
            <View style={[styles.cornerAccent, styles.topRightCorner]} />
            <View style={[styles.cornerAccent, styles.bottomLeftCorner]} />
            <View style={[styles.cornerAccent, styles.bottomRightCorner]} />

            {isCapturing ? (
              <View style={styles.capturingIndicatorContainer}>
                <ActivityIndicator size="large" color="#38BDF8" />
                <Text style={styles.capturingStageText}>{processingStage}</Text>
              </View>
            ) : (
              <View style={styles.viewfinderCenterContent}>
                <Ionicons name="document-text-outline" size={44} color="rgba(255,255,255,0.7)" />
                <Text style={styles.viewfinderHint}>Align Notes or Document</Text>
                <Text style={styles.viewfinderSubHint}>Tap anywhere to transcribe</Text>
              </View>
            )}
          </View>
        </Pressable>

        {/* Bottom Shutter Action Bar */}
        <View style={styles.bottomBar}>
          <Pressable
            onPress={() => executeCapture()}
            disabled={isCapturing}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel={`Read Notes Now. Mode is ${mode}. Double-tap to take photo and read text verbatim.`}
            accessibilityHint="Captures photo and transcribes notes with Gemma 4 OCR"
            style={({ pressed }) => [
              styles.shutterButton,
              isCapturing && styles.shutterButtonDisabled,
              pressed && styles.shutterButtonPressed,
            ]}
          >
            <View style={styles.shutterInnerCircle}>
              <Ionicons name="camera" size={32} color="#FFFFFF" />
              <Text style={styles.shutterButtonLabel}>
                {isCapturing ? "Reading..." : "READ NOTES"}
              </Text>
            </View>
          </Pressable>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#030712",
  },
  screenOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: "space-between",
    backgroundColor: "rgba(0, 0, 0, 0.4)",
  },
  permissionContainer: {
    flex: 1,
    backgroundColor: "#030712",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  permissionTitle: {
    fontSize: 22,
    fontWeight: "bold",
    color: "#FFFFFF",
    marginTop: 18,
    marginBottom: 8,
    textAlign: "center",
  },
  permissionBody: {
    fontSize: 16,
    color: "#94A3B8",
    textAlign: "center",
    lineHeight: 24,
    marginBottom: 28,
  },
  permissionButton: {
    minHeight: 56,
    minWidth: 220,
    backgroundColor: "#FF5500",
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
    marginBottom: 16,
  },
  permissionButtonText: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#FFFFFF",
  },
  permissionCancelButton: {
    minHeight: 56,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  permissionCancelButtonText: {
    fontSize: 16,
    color: "#94A3B8",
  },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  headerButton: {
    minWidth: 56,
    minHeight: 56,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(15, 23, 42, 0.8)",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.2)",
    paddingHorizontal: 12,
  },
  headerButtonPressed: {
    backgroundColor: "rgba(56, 189, 248, 0.3)",
    borderColor: "#38BDF8",
  },
  headerButtonText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#FFFFFF",
    marginTop: 2,
  },
  headerTitleContainer: {
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#FFFFFF",
    letterSpacing: 1.5,
  },
  headerSubtitle: {
    fontSize: 12,
    color: "#38BDF8",
    fontWeight: "500",
  },
  modeSelectorBar: {
    flexDirection: "row",
    justifyContent: "center",
    paddingHorizontal: 16,
    gap: 8,
    marginVertical: 4,
  },
  modeButton: {
    flex: 1,
    minHeight: 56,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(15, 23, 42, 0.85)",
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "rgba(255, 255, 255, 0.15)",
    paddingVertical: 6,
  },
  modeButtonSelected: {
    backgroundColor: "#FF5500",
    borderColor: "#FB923C",
  },
  modeButtonText: {
    fontSize: 13,
    fontWeight: "bold",
    color: "#94A3B8",
  },
  modeButtonTextSelected: {
    color: "#FFFFFF",
  },
  errorOverlayCard: {
    backgroundColor: "rgba(127, 29, 29, 0.95)",
    borderWidth: 1.5,
    borderColor: Colors.error,
    borderRadius: 14,
    marginHorizontal: 16,
    padding: 16,
  },
  errorHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#FCA5A5",
  },
  errorBody: {
    fontSize: 14,
    color: "#FFFFFF",
    lineHeight: 20,
    marginBottom: 12,
  },
  errorButtonsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
  },
  errorDismissButton: {
    minHeight: 56,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  errorDismissButtonText: {
    color: "#94A3B8",
    fontSize: 15,
  },
  errorRetryButton: {
    minHeight: 56,
    backgroundColor: "#DC2626",
    borderRadius: 10,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  errorRetryButtonText: {
    color: "#FFFFFF",
    fontWeight: "bold",
    fontSize: 15,
  },
  viewfinderArea: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  viewfinderPressed: {
    opacity: 0.9,
  },
  viewfinderFrame: {
    width: "100%",
    height: "75%",
    borderRadius: 20,
    borderWidth: 2,
    borderColor: "rgba(56, 189, 248, 0.4)",
    backgroundColor: "rgba(0, 0, 0, 0.25)",
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
  },
  cornerAccent: {
    position: "absolute",
    width: 28,
    height: 28,
    borderColor: "#38BDF8",
  },
  topLeftCorner: {
    top: -2,
    left: -2,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 18,
  },
  topRightCorner: {
    top: -2,
    right: -2,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 18,
  },
  bottomLeftCorner: {
    bottom: -2,
    left: -2,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 18,
  },
  bottomRightCorner: {
    bottom: -2,
    right: -2,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 18,
  },
  capturingIndicatorContainer: {
    alignItems: "center",
    gap: 12,
  },
  capturingStageText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#FFFFFF",
  },
  viewfinderCenterContent: {
    alignItems: "center",
    gap: 6,
  },
  viewfinderHint: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#FFFFFF",
    marginTop: 4,
  },
  viewfinderSubHint: {
    fontSize: 14,
    color: "#94A3B8",
  },
  bottomBar: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    alignItems: "center",
  },
  shutterButton: {
    minHeight: 64,
    width: "100%",
    backgroundColor: "#FF5500",
    borderRadius: 20,
    borderWidth: 2,
    borderColor: "#FB923C",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#FF6D00",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },
  shutterButtonPressed: {
    transform: [{ scale: 0.98 }],
    backgroundColor: "#EA580C",
  },
  shutterButtonDisabled: {
    opacity: 0.6,
  },
  shutterInnerCircle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  shutterButtonLabel: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#FFFFFF",
    letterSpacing: 1,
  },
  badgeRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 6,
    flexWrap: "wrap",
  },
  mathBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(245, 158, 11, 0.2)",
    borderWidth: 1,
    borderColor: "#F59E0B",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  mathBadgeText: {
    fontSize: 12,
    fontWeight: "bold",
    color: "#FBBF24",
  },
  modeBadge: {
    backgroundColor: "rgba(56, 189, 248, 0.2)",
    borderWidth: 1,
    borderColor: "#38BDF8",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  modeBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#38BDF8",
  },
  confidenceBadge: {
    backgroundColor: "rgba(74, 222, 128, 0.2)",
    borderWidth: 1,
    borderColor: "#4ADE80",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  confidenceBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#4ADE80",
  },
  resultsScrollView: {
    flex: 1,
    paddingHorizontal: 16,
  },
  resultsScrollContent: {
    paddingVertical: 12,
  },
  textCard: {
    backgroundColor: "rgba(15, 23, 42, 0.95)",
    borderWidth: 1.5,
    borderColor: "rgba(255, 255, 255, 0.2)",
    borderRadius: 16,
    padding: 20,
    minHeight: 200,
  },
  transcribedText: {
    fontSize: 18,
    lineHeight: 28,
    color: "#FFFFFF",
    letterSpacing: 0.3,
  },
  resultsActionsContainer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
  },
  actionButton: {
    flex: 1,
    minHeight: 56,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  actionButtonPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  copyButton: {
    backgroundColor: "#005CE6",
    borderWidth: 1.5,
    borderColor: "#38BDF8",
  },
  listenButton: {
    backgroundColor: "#00A84D",
    borderWidth: 1.5,
    borderColor: "#4ADE80",
  },
  actionButtonText: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#FFFFFF",
  },
  scanAnotherButton: {
    minHeight: 56,
    backgroundColor: "#FF5500",
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "#FB923C",
    justifyContent: "center",
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  scanAnotherButtonText: {
    fontSize: 17,
    fontWeight: "bold",
    color: "#FFFFFF",
  },
});

export default OcrReaderScreen;
