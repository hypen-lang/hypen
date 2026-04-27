/**
 * Onboarding Example
 * Multi-step onboarding wizard with selectable options.
 */

import { app } from "../../hypen-web/packages/core/src/index.ts";

type Option = { id: string; label: string; selected: boolean };
type Question = {
  id: string;
  title: string;
  subtitle: string;
  options: Option[];
};

type OnboardingState = {
  currentStep: number;
  totalSteps: number;
  questions: Question[];
  currentQuestion: Question;
  canContinue: boolean;
  answers: Record<string, string>;
};

const questions: Question[] = [
  {
    id: "gender",
    title: "What is your gender?",
    subtitle: "Different body types respond differently to training. This helps us select exercises that work best for your physiology.",
    options: [
      { id: "male", label: "Male", selected: false },
      { id: "female", label: "Female", selected: false },
      { id: "other", label: "Rather not say", selected: false },
    ],
  },
  {
    id: "goal",
    title: "What's your main goal?",
    subtitle: "We'll customize your experience based on what you want to achieve.",
    options: [
      { id: "lose", label: "Lose weight", selected: false },
      { id: "gain", label: "Build muscle", selected: false },
      { id: "fit", label: "Get fit & healthy", selected: false },
      { id: "maintain", label: "Maintain weight", selected: false },
    ],
  },
  {
    id: "experience",
    title: "What's your fitness level?",
    subtitle: "Be honest - we'll adjust the difficulty to match your experience.",
    options: [
      { id: "beginner", label: "Beginner", selected: false },
      { id: "intermediate", label: "Intermediate", selected: false },
      { id: "advanced", label: "Advanced", selected: false },
    ],
  },
];

export const onboardingExample = {
  module: app
    .defineState<OnboardingState>({
      currentStep: 1,
      totalSteps: questions.length,
      questions: questions,
      currentQuestion: questions[0],
      canContinue: false,
      answers: {},
    })
    .onAction("selectOption", async ({ action, state }) => {
      const optionId = action.payload?.optionId;
      if (!optionId) return;

      const updatedOptions = state.currentQuestion.options.map(opt => ({
        ...opt,
        selected: opt.id === optionId,
      }));

      state.currentQuestion = {
        ...state.currentQuestion,
        options: updatedOptions,
      };

      state.answers[state.currentQuestion.id] = optionId;
      state.canContinue = true;
    })
    .onAction("continue", async ({ state }) => {
      if (!state.canContinue) return;

      if (state.currentStep < state.totalSteps) {
        state.currentStep++;
        state.currentQuestion = state.questions[state.currentStep - 1];
        state.canContinue = !!state.answers[state.currentQuestion.id];
      } else {
        console.log("Onboarding complete!", state.answers);
        state.currentStep = 1;
        state.currentQuestion = state.questions[0];
        state.canContinue = false;
        state.answers = {};
        state.questions = questions.map(q => ({
          ...q,
          options: q.options.map(o => ({ ...o, selected: false })),
        }));
      }
    })
    .build(),

  ui: `
Column {
  Column {
    Text("@{state.currentQuestion.title}")
      .fontSize(24)
      .fontWeight("700")
      .color("#ffffff")
      .textAlign("center")

    Text("@{state.currentQuestion.subtitle}")
      .fontSize(14)
      .color("#9ca3af")
      .textAlign("center")
      .margin(8)
  }
    .gap(8)
    .padding(16)
    .horizontalAlignment("center")

  Column {
    List(@state.currentQuestion.options) {
      Row {
        Text("@{item.label}")
          .fontSize(16)
          .color("#ffffff")
      }
        .padding(16)
        .backgroundColor("transparent")
        .cornerRadius(12)
        .fillMaxWidth(true)
        .borderWidth("@{item.selected ? 2 : 1}")
        .borderColor("@{item.selected ? '#FFA7E1' : '#374151'}")
        .onClick(@actions.selectOption, optionId: "@{item.id}")
    }
      .gap(12)
      .fillMaxWidth(true)
  }
    .padding(24)
    .gap(12)
    .fillMaxWidth(true)

  Column {
    Row {
      Text("Continue")
        .fontSize(16)
        .fontWeight("600")
        .color("@{state.canContinue ? 'black' : '#6b7280'}")

      Text("→")
        .fontSize(16)
        .margin(8)
        .color("@{state.canContinue ? 'black' : '#6b7280'}")
    }
      .verticalAlignment("center")
      .horizontalAlignment("center")
      .cornerRadius(12)
      .padding(8)
      .paddingLeft(16)
      .fillMaxWidth(true)
      .backgroundColor("@{state.canContinue ? '#FFA7E1' : '#1f2937'}")
      .onClick(@actions.continue)

    Text("Step @{state.currentStep} of @{state.totalSteps}")
      .fontSize(14)
      .color("#6b7280")
      .textAlign("center")
      .margin(12)
  }
    .padding(24)
    .gap(8)
    .fillMaxWidth(true)
}
  .padding(24)
  .gap(24)
  .fillMaxSize(true)
  .backgroundColor("#000000")
  .horizontalAlignment("center")
  .verticalAlignment("center")
`
};
