import React from "react";
import { StyleSheet, View, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";

interface SaarthiLogoProps {
  size?: "small" | "medium" | "large";
  showTagline?: boolean;
}

/**
 * Saarthi Emblem & Wordmark.
 *
 * Symbolism:
 * - "Saarthi" (सारथी): The divine charioteer, guardian, and enlightened guide.
 * - Concentric Radiant Rings: The compass of direction and the protective aura of companionship.
 * - The Luminous Eye & Guiding Star: Inner vision, perception, and guiding light for the blind and low-vision.
 * - Colors: Celestial Cyan (#38BDF8), Guiding Gold (#FBBF24), and Royal Blue (#005CE6).
 */
export const SaarthiLogo: React.FC<SaarthiLogoProps> = ({
  size = "medium",
  showTagline = true,
}) => {
  const isSmall = size === "small";

  return (
    <View
      style={styles.logoRoot}
      accessible={true}
      accessibilityRole="header"
      accessibilityLabel="SAARTHI. Your guiding light and vision companion."
    >
      {/* Radiant Guiding Emblem */}
      <View style={[styles.emblemOuterRing, isSmall && styles.emblemOuterRingSmall]}>
        <View style={[styles.emblemMiddleRing, isSmall && styles.emblemMiddleRingSmall]}>
          <View style={[styles.emblemCore, isSmall && styles.emblemCoreSmall]}>
            {/* The Eye of Vision & Guidance */}
            <Ionicons
              name="eye"
              size={isSmall ? 18 : 26}
              color="#38BDF8"
              style={styles.emblemEyeIcon}
            />
            {/* The Radiant Compass Star */}
            <View style={styles.starWrap}>
              <Ionicons
                name="sparkles"
                size={isSmall ? 10 : 14}
                color="#FBBF24"
              />
            </View>
          </View>
        </View>
      </View>

      {/* Brand Title & Meaningful Tagline */}
      <View style={styles.textContainer}>
        <View style={styles.titleRow}>
          <Text style={[styles.brandTitle, isSmall && styles.brandTitleSmall]}>
            SAARTHI
          </Text>
        </View>

        {showTagline && (
          <View style={styles.taglineWrap}>
            <View style={styles.taglineDot} />
            <Text style={styles.brandTagline}>YOUR GUIDING LIGHT</Text>
            <View style={styles.taglineDot} />
          </View>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  logoRoot: {
    alignItems: "center",
    justifyContent: "center",
  },
  emblemOuterRing: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: "rgba(2, 132, 199, 0.15)",
    borderWidth: 1.5,
    borderColor: "rgba(56, 189, 248, 0.5)",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#38BDF8",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 10,
    elevation: 6,
    marginBottom: 6,
  },
  emblemOuterRingSmall: {
    width: 44,
    height: 44,
    borderRadius: 22,
    marginBottom: 4,
  },
  emblemMiddleRing: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(15, 23, 42, 0.8)",
    borderWidth: 1,
    borderColor: "rgba(251, 191, 36, 0.4)",
    justifyContent: "center",
    alignItems: "center",
  },
  emblemMiddleRingSmall: {
    width: 34,
    height: 34,
    borderRadius: 17,
  },
  emblemCore: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(8, 47, 73, 0.9)",
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
  },
  emblemCoreSmall: {
    width: 26,
    height: 26,
    borderRadius: 13,
  },
  emblemEyeIcon: {
    shadowColor: "#38BDF8",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
  },
  starWrap: {
    position: "absolute",
    top: -2,
    right: -2,
  },
  textContainer: {
    alignItems: "center",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  brandTitle: {
    fontSize: 22,
    fontWeight: "900",
    color: "#FFFFFF",
    letterSpacing: 4,
    textShadowColor: "rgba(56, 189, 248, 0.5)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 8,
  },
  brandTitleSmall: {
    fontSize: 18,
    letterSpacing: 3,
  },
  taglineWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
  },
  taglineDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: "#FBBF24",
  },
  brandTagline: {
    fontSize: 9.5,
    fontWeight: "700",
    color: "#38BDF8",
    letterSpacing: 2,
  },
});

