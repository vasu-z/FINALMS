import React, { useState, useRef, useEffect } from "react";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions, PermissionResponse } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../theme/colors";
import { speechService } from "../services/speech";
import { hapticsService } from "../services/haptics";
import { readingPipeline, ReadingPipelineResult } from "../services/readingPipeline";
import { analyzeSceneWithVision, CampusReadingResponse } from "../api/client";
import { globalVoiceService } from "../services/globalVoiceService";
import { voiceRecognitionService } from "../services/voiceRecognition";

import {
  CameraPermissionState,
  resolveCameraPermissionState,
} from "../utils/cameraPermissions";

export type { CameraPermissionState };
export { resolveCameraPermissionState };

export type ReadingMode = "auto" | "timetable" | "sign" | "notice" | "surroundings";

export interface CampusReaderScreenProps {
  initialMode?: ReadingMode;
  onNavigateBack: () => void;
  onReadingComplete: (result: ReadingPipelineResult, mode: ReadingMode, imageUri?: string) => void;
  permissionResponse?: PermissionResponse | null;
  onRequestPermission?: () => Promise<PermissionResponse>;
  onRegisterScanTrigger?: (trigger: (() => Promise<void>) | null) => void;
  onOpenLiveAssist?: () => void;
}

export const CampusReaderScreen: React.FC<CampusReaderScreenProps> = ({
  initialMode = "auto",
  onNavigateBack,
  onReadingComplete,
  permissionResponse: propPermission,
  onRequestPermission: propRequestPermission,
  onRegisterScanTrigger,
  onOpenLiveAssist,
}) => {
  const insets = useSafeAreaInsets();

  const cameraRef = useRef<CameraView>(null);
  const [hookPermission, hookRequestPermission] = useCameraPermissions();
  const permission = propPermission !== undefined ? propPermission : hookPermission;
  const requestPermission = propRequestPermission || hookRequestPermission;
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [processingStage, setProcessingStage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCameraReady, setIsCameraReady] = useState<boolean>(false);

  const isCapturingRef = useRef<boolean>(false);
  const hasAnnouncedStartupRef = useRef<boolean>(false);

  // 1. Voice-guided startup on mount
  useEffect(() => {
    if (hasAnnouncedStartupRef.current) return;
    hasAnnouncedStartupRef.current = true;

    (async () => {
      const voiceState = globalVoiceService.getState();
      const avail = voiceRecognitionService.checkAvailability();

      if (!avail.available) {
        const recoveryMsg =
          "See the World active. Point your camera steady forward at your surroundings, signs, or boards. Tap anywhere on the screen or press the scan button to inspect.";
        await speechService.speak(recoveryMsg, { force: true });
        return;
      }

      if (voiceState.isActive && voiceState.isPaused) {
        const pausedMsg =
          "See the World active. Point your camera forward. Voice listening is paused. Tap the scan button or tap anywhere to take a scan.";
        await speechService.speak(pausedMsg, { force: true });
        return;
      }

      if (voiceState.isActive && !voiceState.isPaused) {
        const guideMsg =
          "See the World active. Point your camera steady at any object, sign, or surroundings. Say 'scan now' or tap to capture.";
        await speechService.speak(guideMsg, { force: true });
        return;
      }

      const micGranted = await voiceRecognitionService.requestPermissions();
      if (!micGranted) {
        const micDeniedMsg =
          "See the World active. Tap the large scan button at the bottom or tap anywhere on the screen to inspect.";
        await speechService.speak(micDeniedMsg, { force: true });
        return;
      }

      await globalVoiceService.enableVoiceMode(
        "Read Anything active. Point your camera forward. Say 'scan now' or tap to capture."
      );
    })();
  }, []);

  // 2. Register real scan trigger for voice dispatcher
  useEffect(() => {
    if (onRegisterScanTrigger) {
      onRegisterScanTrigger(async () => {
        await executeCapture();
      });
    }
    return () => {
      onRegisterScanTrigger?.(null);
    };
  }, [onRegisterScanTrigger]);

  // Replay spoken screen instructions
  const handleAnnounceInstructions = async () => {
    await hapticsService.triggerButtonPress();
    const instructions =
      "See the World. Point your camera forward at your surroundings, room signs, door plaques, or boards. Tap anywhere on the camera view or press the large Scan button at the bottom to explore.";
    await speechService.speak(instructions, { force: true });
  };

  // Safe navigation back to home
  const handleBack = async () => {
    await hapticsService.triggerBottomLeft();
    await speechService.stop();
    onNavigateBack();
  };

  // Unified capture pipeline: reads everything in view with deterministic confidence scoring
  const executeCapture = async (mode: ReadingMode = "auto") => {
    if (isCapturingRef.current || isCapturing) {
      console.log("[CampusReaderScreen] executeCapture skipped: already capturing");
      return;
    }

    if (!permission?.granted) {
      await speechService.speak("Camera permission is required to take a scan.", { force: true });
      return;
    }

    if (!cameraRef.current) {
      await speechService.speak("Camera is initializing, please wait a moment.", { force: true });
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
        quality: 0.85,
        skipProcessing: false,
      });

      if (!photo || !photo.uri) {
        throw new Error("Camera did not return a valid photo.");
      }

      setProcessingStage("Reading text, signs, schedules & notices...");
      await speechService.speak("Image captured. Reading view...", { force: true });

      const result = await readingPipeline.processCampusImage({
        imageUri: photo.uri,
        imageBase64: photo.base64,
        readingMode: "auto",
      });

      setIsCapturing(false);
      isCapturingRef.current = false;
      setProcessingStage("");
      onReadingComplete(result, "auto", photo.uri);
    } catch (err: any) {
      setIsCapturing(false);
      isCapturingRef.current = false;
      setProcessingStage("");
      const msg =
        err?.message ||
        "I couldn't read that clearly. Please hold steady, ensure good lighting, and tap scan to try again.";
      setErrorMessage(msg);
      await speechService.speak(msg, { force: true });
    }
  };

  // Surroundings / Live Camera Assist quick access
  const handleOpenSurroundings = () => {
    if (onOpenLiveAssist) {
      onOpenLiveAssist();
    }
  };

  // Permission handling: Distinguish between loading, denied, and granted states
  const permissionState = resolveCameraPermissionState(permission);

  if (permissionState === "loading") {
    return (
      <View
        style={[
          styles.loadingContainer,
          {
            paddingTop: Math.max(insets.top, 16),
            paddingBottom: Math.max(insets.bottom, 16),
          },
        ]}
        accessible={true}
        accessibilityRole="progressbar"
        accessibilityLabel="Initializing camera"
      >
        <ActivityIndicator size="large" color="#38BDF8" />
        <Text style={styles.loadingStateText}>Starting Camera...</Text>
      </View>
    );
  }

  if (permissionState === "denied") {
    return (
      <View
        style={[
          styles.permissionContainer,
          {
            paddingTop: insets.top + 24,
            paddingBottom: insets.bottom + 24,
          },
        ]}
      >
        <Ionicons name="camera-outline" size={72} color={Colors.warning} />
        <Text style={styles.permissionTitle}>Camera Access Required</Text>
        <Text style={styles.permissionDescription}>
          SAARTHI uses your camera in real time to read door signs, schedules, notices, and printed documents aloud.
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

  return (
    <View style={styles.container}>
      {/* 1. Live Camera Viewport in Background */}
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        mode="picture"
        onCameraReady={() => setIsCameraReady(true)}
      />

      {/* 2. Structured Transparent UI Framing Overlay */}
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
            style={({ pressed }) => [
              styles.headerButton,
              pressed && styles.headerButtonPressed,
            ]}
            hitSlop={8}
          >
            <Ionicons name="arrow-back" size={26} color="#FFFFFF" />
            <Text style={styles.headerButtonText}>Back</Text>
          </Pressable>

          <View style={styles.headerTitleContainer} accessible={true} accessibilityRole="header">
            <Text style={styles.headerTitle}>SEE THE WORLD</Text>
            <Text style={styles.headerSubtitle}>Surroundings, Signs & Vision</Text>
          </View>

          <Pressable
            onPress={handleAnnounceInstructions}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Help and instructions"
            accessibilityHint="Double tap to hear instructions for reading text and signs"
            style={({ pressed }) => [
              styles.headerButton,
              pressed && styles.headerButtonPressed,
            ]}
            hitSlop={8}
          >
            <Ionicons name="volume-high" size={26} color="#FFFFFF" />
            <Text style={styles.headerButtonText}>Help</Text>
          </Pressable>
        </View>

        {/* Error Recovery Card (if scan failed) */}
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
          accessibilityLabel="Camera Viewfinder. Double-tap anywhere to take a photo and read."
          accessibilityHint="Scans and reads whatever is currently in front of your camera"
          style={({ pressed }) => [
            styles.viewfinderArea,
            pressed && styles.viewfinderPressed,
          ]}
        >
          <View style={styles.viewfinderFrame}>
            {/* Viewfinder Corner Accents */}
            <View style={[styles.cornerMarker, styles.cornerTopLeft]} />
            <View style={[styles.cornerMarker, styles.cornerTopRight]} />
            <View style={[styles.cornerMarker, styles.cornerBottomLeft]} />
            <View style={[styles.cornerMarker, styles.cornerBottomRight]} />

            <View style={styles.viewfinderPromptContainer}>
              <Ionicons name="scan-outline" size={48} color="rgba(56, 189, 248, 0.85)" />
              <Text style={styles.viewfinderPromptText}>
                Aim camera at any text, sign, schedule, or notice
              </Text>
              <Text style={styles.viewfinderSubPromptText}>
                Tap screen to scan
              </Text>
            </View>
          </View>
        </Pressable>

        {/* Bottom Shutter & Action Bar */}
        <View style={styles.bottomBar}>
          <Pressable
            onPress={() => executeCapture()}
            disabled={isCapturing}
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="Scan Now. Large primary action button. Double tap to capture and read aloud."
            accessibilityHint="Captures photo and reads all detected text, door signs, timetables, or notices"
            style={({ pressed }) => [
              styles.scanNowButton,
              pressed && styles.scanNowButtonPressed,
            ]}
          >
            <View style={styles.scanButtonInner}>
              <View style={styles.scanIconWrapper}>
                <Ionicons name="camera" size={34} color="#FFFFFF" />
              </View>
              <View style={styles.scanButtonTextWrapper}>
                <Text style={styles.scanButtonTitle}>SCAN NOW</Text>
                <Text style={styles.scanButtonSubtitle}>Read whatever is in front of you</Text>
              </View>
            </View>
          </Pressable>

          {/* Optional Live Camera Assist / Surroundings shortcut */}
          {onOpenLiveAssist && (
            <Pressable
              onPress={handleOpenSurroundings}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Describe Surroundings. Switch to live obstacle and scene assistant."
              accessibilityHint="Opens Live Camera Assist for obstacle detection and scene understanding"
              style={({ pressed }) => [
                styles.surroundingsPill,
                pressed && styles.surroundingsPillPressed,
              ]}
            >
              <Ionicons name="eye-outline" size={20} color="#C084FC" style={{ marginRight: 8 }} />
              <Text style={styles.surroundingsPillText}>Describe Surroundings</Text>
            </Pressable>
          )}
        </View>

        {/* Processing State Overlay */}
        {isCapturing && (
          <View style={styles.loadingOverlay} accessible={true} accessibilityRole="progressbar">
            <View style={styles.loadingCard}>
              <ActivityIndicator size="large" color="#38BDF8" />
              <Text style={styles.loadingTitle}>Reading View</Text>
              <Text style={styles.loadingSubtitle}>{processingStage}</Text>
            </View>
          </View>
        )}
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
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(3, 7, 18, 0.4)", // Translucent dark overlay allowing camera visibility
    paddingHorizontal: 16,
    justifyContent: "space-between",
  },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(15, 23, 42, 0.88)",
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1.5,
    borderColor: "rgba(255, 255, 255, 0.12)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  headerButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1E293B",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 14,
    minHeight: 56,
    minWidth: 70,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.15)",
  },
  headerButtonPressed: {
    opacity: 0.8,
    backgroundColor: "#334155",
  },
  headerButtonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
    marginLeft: 6,
  },
  headerTitleContainer: {
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    paddingHorizontal: 8,
  },
  headerTitle: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  headerSubtitle: {
    color: "#94A3B8",
    fontSize: 11,
    fontWeight: "600",
    marginTop: 2,
  },
  viewfinderArea: {
    flex: 1,
    marginVertical: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  viewfinderPressed: {
    opacity: 0.9,
  },
  viewfinderFrame: {
    width: "100%",
    height: "100%",
    maxHeight: 460,
    borderWidth: 1.5,
    borderColor: "rgba(56, 189, 248, 0.4)",
    borderRadius: 24,
    backgroundColor: "rgba(15, 23, 42, 0.2)",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    padding: 20,
  },
  cornerMarker: {
    position: "absolute",
    width: 28,
    height: 28,
    borderColor: "#38BDF8",
  },
  cornerTopLeft: {
    top: -2,
    left: -2,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 18,
  },
  cornerTopRight: {
    top: -2,
    right: -2,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 18,
  },
  cornerBottomLeft: {
    bottom: -2,
    left: -2,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 18,
  },
  cornerBottomRight: {
    bottom: -2,
    right: -2,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 18,
  },
  viewfinderPromptContainer: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(15, 23, 42, 0.75)",
    paddingVertical: 18,
    paddingHorizontal: 22,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(56, 189, 248, 0.3)",
  },
  viewfinderPromptText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
    marginTop: 10,
    lineHeight: 20,
    maxWidth: 240,
  },
  viewfinderSubPromptText: {
    color: "#38BDF8",
    fontSize: 13,
    fontWeight: "800",
    marginTop: 8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  bottomBar: {
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  scanNowButton: {
    width: "100%",
    backgroundColor: "#005CE6",
    borderRadius: 24,
    borderWidth: 2,
    borderColor: "#38BDF8",
    paddingVertical: 14,
    paddingHorizontal: 20,
    minHeight: 76,
    justifyContent: "center",
    shadowColor: "#0066FF",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.6,
    shadowRadius: 12,
    elevation: 8,
  },
  scanNowButtonPressed: {
    opacity: 0.88,
    transform: [{ scale: 0.98 }],
  },
  scanButtonInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  scanIconWrapper: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "rgba(255, 255, 255, 0.18)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 16,
  },
  scanButtonTextWrapper: {
    justifyContent: "center",
  },
  scanButtonTitle: {
    color: "#FFFFFF",
    fontSize: 22,
    fontWeight: "900",
    letterSpacing: 0.8,
  },
  scanButtonSubtitle: {
    color: "rgba(255, 255, 255, 0.9)",
    fontSize: 13,
    fontWeight: "600",
    marginTop: 2,
  },
  surroundingsPill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(31, 14, 66, 0.85)",
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: "#C084FC",
    minHeight: 48,
  },
  surroundingsPillPressed: {
    opacity: 0.8,
    backgroundColor: "#2E1065",
  },
  surroundingsPillText: {
    color: "#E9D5FF",
    fontSize: 14,
    fontWeight: "700",
  },
  errorOverlayCard: {
    backgroundColor: "#1E1218",
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: Colors.error,
    padding: 14,
    marginVertical: 10,
  },
  errorHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  errorTitle: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "800",
  },
  errorBody: {
    color: "#E2E8F0",
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  errorButtonsRow: {
    flexDirection: "row",
    gap: 10,
  },
  errorDismissButton: {
    flex: 1,
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    minHeight: 48,
    justifyContent: "center",
  },
  errorDismissButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
  },
  errorRetryButton: {
    flex: 1,
    backgroundColor: "#05DF72",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    minHeight: 48,
    justifyContent: "center",
  },
  errorRetryButtonText: {
    color: "#030712",
    fontSize: 13,
    fontWeight: "800",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(3, 7, 18, 0.85)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 25,
  },
  loadingCard: {
    backgroundColor: "#0F172A",
    borderRadius: 18,
    padding: 24,
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#38BDF8",
    width: "80%",
    maxWidth: 320,
  },
  loadingTitle: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "800",
    marginTop: 14,
    textAlign: "center",
  },
  loadingSubtitle: {
    color: "#94A3B8",
    fontSize: 13,
    marginTop: 6,
    textAlign: "center",
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: "#030712",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  loadingStateText: {
    color: "#94A3B8",
    fontSize: 15,
    fontWeight: "600",
    marginTop: 14,
    textAlign: "center",
  },
  permissionContainer: {
    flex: 1,
    backgroundColor: Colors.background,
    padding: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  permissionTitle: {
    fontSize: 24,
    fontWeight: "900",
    color: Colors.textPrimary,
    marginTop: 20,
    marginBottom: 12,
    textAlign: "center",
  },
  permissionDescription: {
    fontSize: 15,
    color: Colors.textSecondary,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 28,
  },
  permissionButton: {
    width: "100%",
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    minHeight: 56,
    justifyContent: "center",
    marginBottom: 12,
  },
  permissionButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "800",
  },
  permissionCancelButton: {
    width: "100%",
    backgroundColor: Colors.surface,
    borderWidth: 1.5,
    borderColor: Colors.border,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
    minHeight: 52,
    justifyContent: "center",
  },
  permissionCancelButtonText: {
    color: Colors.textPrimary,
    fontSize: 15,
    fontWeight: "700",
  },
});
