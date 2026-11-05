import type { Skill } from '../types'

export const careerDocuments: Skill = {
  name: 'career-documents',
  description:
    "Job application documents: CV with impact bullets (action verb + task + measurable result), ATS compatibility rules, French CV conventions, lettre de motivation structure (vous/moi/nous), STAR interview preparation, LinkedIn profile optimization and tailoring every application. Use when the user asks for help with a CV or resume, a lettre de motivation or cover letter, an entretien d'embauche or interview prep, their LinkedIn profile, or tailoring an application to a job posting.",
  keywords: [
    'cv', 'curriculum vitae', 'resume', 'lettre de motivation', 'cover letter',
    'candidature', 'postuler', 'entretien', "entretien d'embauche", 'interview',
    'recrutement', 'recruteur', 'ats', 'profil linkedin', 'linkedin',
    'competences', 'experiences', "offre d'emploi", 'job', 'emploi', 'stage',
    'alternance', 'star method', 'faire mon cv', 'modele de cv',
    'reussir son cv', 'carriere', 'career', 'recherche emploi'
  ],
  body: `# Career Documents (CV, cover letter, interviews)

## CV structure
- Order under 10 years of experience: header (name, title, contact, links) -> Experience -> Education -> Competences -> Projects/Languages.
- Impact bullet formula: strong action verb + task/context + measurable result. "Reduced API latency 40% by adding Redis caching for 200k daily requests."
- 3-6 bullets per role; at least half carry a number; lead with the result when it is impressive.
- One page under 10 years of experience; two pages only for senior or dense academic careers.

## ATS compatibility rules
- Standard section titles: Experience, Education, Skills — never creative headers like "My journey".
- Single column, no tables, no text inside images, no content in headers/footers (some parsers drop them).
- Export a real-text PDF and run the copy-paste test: if you cannot select the text, the ATS cannot read it.
- Mirror keywords from the job posting verbatim where truthful — both hard skills and tools.
- File name: Firstname-Lastname-Role.pdf.

## French CV conventions
- One page, strictly.
- No photo, no age, no marital status, no nationality unless legally required.
- Expected "Competences" section: hard skills and tools with levels (languages with CEFR: B2, C1); drop generic soft skills or tie each one to proof.
- Dates in Mois AAAA (Mars 2024), reverse chronological order.

## Lettre de motivation structure (3 paragraphs)
1. VOUS: the company and why them specifically — one researched fact proves you did your homework.
2. MOI: 2-3 experiences mapped to their stated needs, each with a number.
3. NOUS: what the collaboration produces, availability, polite formal close.
- Never open with "Je vous ecris car je recherche un emploi" (zero information). One page maximum, formal register, vouvoiement.

## Interview preparation — STAR method
For each story: Situation (1-2 sentences), Task (your responsibility), Action (what YOU did — 60% of the answer), Result (quantified, plus what you learned).
- Prepare 6 stories covering: a success, a failure, a conflict, leadership, a tight deadline, a change you drove.
- Prepare 3 questions about the team and its challenges; never lead with salary in round one.

## LinkedIn optimization
- Headline formula: [Role] | [what you do / value] | [proof or tools]. Never just "Etudiant".
- About section: first 2 lines are the hook (shown before "see more"), then 3 career proof points, then a direct reason to contact you.
- Personalized URL; skills ordered by the target role; recommendations requested from people who can cite numbers.

## Tailoring every application
- Extract the 5 real requirements from each posting; reorder and rephrase your bullets to hit them in the same vocabulary; cut everything irrelevant to them.
- 5 tailored applications outperform 50 generic ones. Track every application in a simple sheet: company, role, date, contact, follow-up sent.`
}

export default careerDocuments
