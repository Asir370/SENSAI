// actions/resume.js
"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { GoogleGenerativeAI } from "@google/generative-ai";

/* -------------------- Lazy model init (safe at import time) -------------------- */
let _model = null;
function getModelOrThrow() {
  if (_model) return _model;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const genAI = new GoogleGenerativeAI(key);
  // Use a conservative model name. Update if your account supports different names.
  _model = genAI.getGenerativeModel({ model: "gemini-2.5" });
  return _model;
}

/* -------------------- saveResume -------------------- */
export async function saveResume(content) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({ where: { clerkUserId: userId } });
  if (!user) throw new Error("User not found");

  try {
    const resume = await db.resume.upsert({
      where: { userId: user.id },
      update: { content },
      create: { userId: user.id, content },
    });

    try { revalidatePath("/resume"); } catch (e) {}

    return resume;
  } catch (err) {
    console.error("saveResume error:", err);
    throw new Error("Failed to save resume");
  }
}

/* -------------------- getResume -------------------- */
export async function getResume() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({ where: { clerkUserId: userId } });
  if (!user) throw new Error("User not found");

  try {
    return await db.resume.findUnique({ where: { userId: user.id } });
  } catch (err) {
    console.error("getResume error:", err);
    throw new Error("Failed to fetch resume");
  }
}

/* -------------------- improveWithAI -------------------- */
export async function improveWithAI({ current = "", type = "role" }) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
    include: { industryInsight: true },
  });
  if (!user) throw new Error("User not found");

  const prompt = `
As an expert resume writer, improve the following ${type} description for a ${user.industry || "general"} professional.
Make it more impactful, quantifiable, and aligned with industry standards.
Current content: "${current}"

Requirements:
1. Use action verbs
2. Include metrics and results where possible
3. Highlight relevant technical skills
4. Keep it concise but detailed
5. Focus on achievements over responsibilities
6. Use industry-specific keywords

Return only a single-paragraph improved description (no commentary).
`;

  try {
    const model = getModelOrThrow();
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    console.warn("AI improve failed, falling back locally:", err?.message || err);
    return localImproveFallback(current);
  }
}

/* -------------------- generateResumeTemplate -------------------- */
/**
 * Generates a compact, single-page-ready HTML snippet.
 * If AI is available, it uses the model; otherwise returns a compact fallback HTML.
 */
export async function generateResumeTemplate(data) {
  const {
    name = "",
    title = "",
    address = "",
    email = "",
    phone = "",
    summary = "",
    experience = [],
    education = [],
    skills = [],
  } = data || {};

  const prompt = `
Produce a compact, single-A4-page resume as an HTML fragment with inline <style>.
Constraints:
- Fit on one A4 page when printed as PDF. Use compact typography.
- Use @page { size: A4; margin: 10mm; } and avoid page-breaks.
- Max 3 experience items, max 3 bullets each, concise summary <= 420 chars.
Return only the HTML fragment (<div class="resume">...</div>).
Data:
Name: ${name}
Title: ${title}
Email: ${email}
Phone: ${phone}
Summary: ${summary}
Experience: ${JSON.stringify(experience)}
Education: ${JSON.stringify(education)}
Skills: ${skills.join(", ")}
`;

  try {
    const model = getModelOrThrow();
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    console.warn("generateResumeTemplate AI failed, sending compact fallback:", err?.message || err);

    // Compact fallback (single-page friendly)
    const compactExperience = (experience || []).slice(0, 3).map((e) => ({
      role: e.role?.slice(0, 60) || "",
      company: e.company?.slice(0, 60) || "",
      startEnd: e.startEnd?.slice(0, 40) || "",
      bullets: (e.bullets || []).slice(0, 3).map(b => (b || "").slice(0, 140)),
    }));

    const compactEducation = (education || []).slice(0, 2).map(e => ({
      degree: (e.degree || "").slice(0, 80),
      school: (e.school || "").slice(0, 80),
      year: (e.year || "").slice(0, 10),
    }));

    const skillsCompact = (skills || []).slice(0, 12);

    return `<div class="resume-wrapper"><style>
@page { size: A4; margin: 10mm; }
.resume-wrapper{width:calc(210mm - 20mm); margin:0 auto; font-family:system-ui,Arial; }
.resume{font-size:11px; line-height:1.12; color:#111; padding:6px 8px; transform-origin:top left;}
h1{font-size:16px;margin:0} h2{font-size:12px;margin:8px 0 6px}
.meta{font-size:10px;margin-bottom:8px}
.section{margin-bottom:6px}
ul{margin:6px 0;padding-left:18px}
li{margin-bottom:4px}
.skill{display:inline-block;margin-right:6px;font-size:10px;padding:2px 6px;border-bottom:1px dotted #666}
</style>
<div class="resume">
  <h1>${escapeHtml(name)}</h1>
  <div class="meta">${escapeHtml(title)} • ${escapeHtml(email)} • ${escapeHtml(phone)}</div>
  <section class="section"><h2>Summary</h2><p>${escapeHtml(summary?.slice(0,420))}</p></section>
  <section class="section"><h2>Experience</h2>
    ${compactExperience.map(e=>`<div><strong>${escapeHtml(e.role)} — ${escapeHtml(e.company)}</strong><div style="font-size:10px">${escapeHtml(e.startEnd)}</div><ul>${e.bullets.map(b=>`<li>${escapeHtml(b)}</li>`).join("")}</ul></div>`).join("")}
  </section>
  <section class="section"><h2>Education</h2>
    ${compactEducation.map(ed=>`<div style="font-size:11px">${escapeHtml(ed.degree)} — ${escapeHtml(ed.school)} ${escapeHtml(ed.year)}</div>`).join("")}
  </section>
  <section class="section"><h2>Skills</h2>
    <div>${skillsCompact.map(s=>`<span class="skill">${escapeHtml(s)}</span>`).join("")}</div>
  </section>
</div></div>`;
  }
}

/* -------------------- helpers -------------------- */
function localImproveFallback(text = "") {
  if (!text) return "";
  let s = text.replace(/\b(responsible for|was responsible for)\b/gi, "led");
  s = s.replace(/\b(assisted with|helped with)\b/gi, "supported");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 250) s = s.slice(0, 247).trim() + "…";
  return s;
}

function escapeHtml(str = "") {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
