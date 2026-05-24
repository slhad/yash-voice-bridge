import { describe, expect, test } from "bun:test";

import { __testing } from "./actionMapper";

const markerCreateAction = {
  id: "marker.create",
  title: "Create Stream Marker",
  description: "Create a marker on one or more platforms.",
  domain: "markers",
  ipcEnabled: true,
  readOnly: false,
  safety: "safe" as const,
  voiceHint: true,
  args: {
    text: { type: "string" as const, required: false, maxLength: 200 },
    platform: {
      type: "enum" as const,
      required: false,
      values: ["youtube", "twitch", "kick", "all"],
    },
  },
  examples: [
    {
      args: { text: "Intro" },
      description: 'Create a marker labelled "Intro" on all platforms',
    },
  ],
};

const obsShutdownInitiateAction = {
  id: "obs.shutdown.initiate",
  title: "Initiate OBS shutdown countdown",
  description: "Switches to an ending OBS scene, posts countdown messages to chat at a set interval, then stops the OBS stream.",
  domain: "obs",
  ipcEnabled: true,
  readOnly: false,
  safety: "safe" as const,
  voiceHint: true,
  args: {
    delay: { type: "number" as const, required: false, min: 10, max: 3600 },
    scene: { type: "string" as const, required: false, maxLength: 200 },
    message: { type: "string" as const, required: false, maxLength: 500 },
    source: { type: "string" as const, required: false, maxLength: 200 },
    sourceText: { type: "string" as const, required: false, maxLength: 200 },
  },
  examples: [
    { args: {}, description: "Start countdown with config defaults" },
    { args: { delay: 60 }, description: "Shutdown in 60 seconds" },
  ],
};

describe("actionMapper string args", () => {
  test("strips command phrase before free text", () => {
    expect(__testing.extractArgs("create marker Coucou, c'est moi.", markerCreateAction)).toEqual({
      text: "Coucou, c'est moi.",
    });
  });

  test("strips plural command phrase and enum before free text", () => {
    expect(__testing.extractArgs("create markers youtube Coucou, c'est moi.", markerCreateAction)).toEqual({
      platform: "youtube",
      text: "Coucou, c'est moi.",
    });
  });

  test("leaves empty text when only the command phrase was spoken", () => {
    expect(__testing.extractArgs("Euh... le create markers.", markerCreateAction)).toEqual({});
  });

  test("does not infer a generic string arg for multi-string actions", () => {
    expect(__testing.extractArgs("initiate obs shutdown countdown", obsShutdownInitiateAction)).toEqual({});
  });

  test("recognizes embedded english command phrase", () => {
    expect(__testing.hasCommandPhraseMatch("it in english create marker i want to eat apple", markerCreateAction)).toBe(
      true,
    );
  });

  test("does not treat generic example words as a command", () => {
    expect(__testing.hasCommandPhraseMatch("You have a lot of examples.", markerCreateAction)).toBe(false);
    expect(__testing.hasExactPhraseMatch("You have a lot of examples.", markerCreateAction)).toBe(false);
  });

  test("does not treat french filler as a command phrase", () => {
    expect(__testing.hasCommandPhraseMatch("Je ne sais pas si il y a un B ou un TT.", markerCreateAction)).toBe(
      false,
    );
  });
});
