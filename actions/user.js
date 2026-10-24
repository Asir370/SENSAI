"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { generateAIInsights } from "./dashboard";

/**
 * Build create payload for IndustryInsight, only including fields that exist on `insights`.
 * If insights are missing required non-null fields (like growthRate), provide sensible defaults.
 */
function buildInsightCreatePayload(industry, insights) {
  const base = {
    industry,
    nextUpdate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };

  // Arrays - always include sensible defaults
  const arrays = {
    salaryRanges: insights?.salaryRanges ?? [],
    topSkills: insights?.topSkills ?? [],
    keyTrends: insights?.keyTrends ?? [],
    recommendedSkills: insights?.recommendedSkills ?? [],
  };

  // Scalars - only include if present. Provide defaults for required fields.
  const scalars = {
    // growthRate is required in your schema — provide default 0.0 when missing
    growthRate: insights?.growthRate ?? 0.0,
    // demandLevel/marketOutlook: if your schema requires them, consider adding defaults here too.
    ...(insights && insights.demandLevel !== undefined ? { demandLevel: insights.demandLevel } : {}),
    ...(insights && insights.marketOutlook !== undefined ? { marketOutlook: insights.marketOutlook } : {}),
  };

  return {
    ...base,
    ...arrays,
    ...scalars,
  };
}

/**
 * Build update payload for IndustryInsight, only including fields that exist on `insights`.
 */
function buildInsightUpdatePayload(insights) {
  if (!insights) return {};

  return {
    ...(insights.salaryRanges ? { salaryRanges: insights.salaryRanges } : {}),
    ...(insights.topSkills ? { topSkills: insights.topSkills } : {}),
    ...(insights.keyTrends ? { keyTrends: insights.keyTrends } : {}),
    ...(insights.recommendedSkills ? { recommendedSkills: insights.recommendedSkills } : {}),
    ...(insights.growthRate !== undefined ? { growthRate: insights.growthRate } : {}),
    ...(insights.demandLevel !== undefined ? { demandLevel: insights.demandLevel } : {}),
    ...(insights.marketOutlook !== undefined ? { marketOutlook: insights.marketOutlook } : {}),
    ...(insights ? { nextUpdate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } : {}),
  };
}

export async function updateUser(data) {
  try {
    const { userId } = await auth();
    console.log("updateUser: auth userId:", userId);
    if (!userId) throw new Error("Unauthorized");

    const existingUser = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!existingUser) throw new Error("User not found");
    if (!data?.industry) throw new Error("Industry is required");

    // 1) Quick check if industryInsight exists
    let industryInsight = await db.industryInsight.findUnique({
      where: { industry: data.industry },
    });

    // 2) If absent, run the slow call BEFORE transaction and get insights
    let insights = null;
    if (!industryInsight) {
      console.log("updateUser: generating AI insights for", data.industry);
      try {
        const t0 = Date.now();
        insights = await generateAIInsights(data.industry);
        console.log("generateAIInsights took", Date.now() - t0, "ms");
        if (!insights) {
          throw new Error("generateAIInsights returned no insights");
        }
      } catch (err) {
        console.error("updateUser: generateAIInsights failed:", err);
        throw new Error("Failed to generate industry insights");
      }
    }

    try {
      // 3) Short transaction: upsert the industryInsight and update the user.
      const result = await db.$transaction(
        async (tx) => {
          const upsertedIndustryInsight = await tx.industryInsight.upsert({
            where: { industry: data.industry },
            update: {
              // only update fields when insights provided (avoids setting null)
              ...buildInsightUpdatePayload(insights),
            },
            create: {
              // conditionally include only safe fields (no explicit nulls)
              ...buildInsightCreatePayload(data.industry, insights),
            },
          });

          const updatedUser = await tx.user.update({
            where: { id: existingUser.id },
            data: {
              industry: data.industry,
              experience: data.experience,
              bio: data.bio,
              skills: Array.isArray(data.skills) ? data.skills : [],
            },
          });

          return { updatedUser, industryInsight: upsertedIndustryInsight };
        },
        {
          timeout: 10000,
        }
      );

      // Revalidate home/dashboard
      try {
        revalidatePath("/");
      } catch (revalErr) {
        console.warn("updateUser: revalidatePath failed:", revalErr);
      }

      return result.updatedUser;
    } catch (txError) {
      console.error("Error in transaction while updating user:", txError);
      throw txError;
    }
  } catch (error) {
    console.error("Error updating user and industry (full):", error);
    throw error;
  }
}

export async function getUserOnboardingStatus() {
  try {
    const { userId } = await auth();
    console.log("getUserOnboardingStatus: auth userId:", userId);
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
      select: { industry: true },
    });

    console.log("getUserOnboardingStatus: db result:", user);

    if (!user) throw new Error("User not found");

    return { isOnboarded: !!user.industry };
  } catch (error) {
    console.error("Error checking onboarding status (full):", error);
    throw error;
  }
}
