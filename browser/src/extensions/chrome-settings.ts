import type { ArgSpec } from "./validate";

// The browser settings extensions read and change through ChromeSetting
// objects (chrome.privacy.*, chrome.accessibilityFeatures.*), with the value
// type each one accepts, as listed by Chrome on macOS.
export const IP_HANDLING_POLICIES = [
  "default",
  "default_public_and_private_interfaces",
  "default_public_interface_only",
  "disable_non_proxied_udp",
];
export const AUTOFILL_BLOCKED_TYPES = ["contact_info", "payments", "identity_docs", "travel", "all"];
export const ANIMATION_POLICIES = ["allowed", "once", "none"];

const boolean: ArgSpec = { type: "boolean" };

export const PRIVACY_SETTINGS: Record<string, ArgSpec> = {
  "network.networkPredictionEnabled": boolean,
  "network.webRTCIPHandlingPolicy": { type: "string", enum: IP_HANDLING_POLICIES },
  "services.alternateErrorPagesEnabled": boolean,
  "services.autofillEnabled": boolean,
  "services.autofillAddressEnabled": boolean,
  "services.autofillCreditCardEnabled": boolean,
  "services.autofillSettings": {
    type: "array",
    items: {
      type: "object",
      properties: {
        urlPattern: { type: "string" },
        blockedTypes: { type: "array", items: { type: "string", enum: AUTOFILL_BLOCKED_TYPES } },
      },
    },
  },
  "services.passwordSavingEnabled": boolean,
  "services.safeBrowsingEnabled": boolean,
  "services.safeBrowsingExtendedReportingEnabled": boolean,
  "services.searchSuggestEnabled": boolean,
  "services.spellingServiceEnabled": boolean,
  "services.translationServiceEnabled": boolean,
  "websites.thirdPartyCookiesAllowed": boolean,
  "websites.topicsEnabled": boolean,
  "websites.fledgeEnabled": boolean,
  "websites.adMeasurementEnabled": boolean,
  "websites.hyperlinkAuditingEnabled": boolean,
  "websites.referrersEnabled": boolean,
  "websites.doNotTrackEnabled": boolean,
};

export const ACCESSIBILITY_SETTINGS: Record<string, ArgSpec> = {
  animationPolicy: { type: "string", enum: ANIMATION_POLICIES },
};

export const settingKey = (path: string) => path.slice(path.lastIndexOf(".") + 1);

export const CHROME_SETTING_KEYS = [...Object.keys(PRIVACY_SETTINGS), ...Object.keys(ACCESSIBILITY_SETTINGS)].map(settingKey);

export const GENERIC_FONT_FAMILIES = ["standard", "sansserif", "serif", "fixed", "cursive", "fantasy", "math"];
