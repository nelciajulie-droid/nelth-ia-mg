/**
 * The platform's own domain-expertise library (16 skills), complementary to
 * the Anthropic agent-skills archive in ../catalog.ts:
 *  - catalog  = artifact/document skills (pdf, docx, xlsx, pptx, canvas…)
 *  - library  = broad domain expertise (landing pages, SEO, copywriting,
 *               data analysis, career docs, translation…) that makes the
 *               assistant "tout terrain" like claude.ai's skill bar.
 * Both are merged at runtime by ../selector.ts (pre-selection) and
 * ../registry.ts (manifest) — add a file here and it joins both
 * automatically.
 */
import type { Skill } from '../types';

import { landingPageCreation } from './landing-page-creation';
import { uiUxBestPractices } from './ui-ux-best-practices';
import { fullstackDevelopment } from './fullstack-development';
import { backendApiDesign } from './backend-api-design';
import { databaseOptimization } from './database-optimization';
import { codeReviewDebugging } from './code-review-debugging';
import { seoOptimization } from './seo-optimization';
import { copywritingMarketing } from './copywriting-marketing';
import { technicalWriting } from './technical-writing';
import { dataAnalysis } from './data-analysis';
import { imageGenerationPrompting } from './image-generation-prompting';
import { videoScriptWriting } from './video-script-writing';
import { socialMediaContent } from './social-media-content';
import { businessStrategy } from './business-strategy';
import { careerDocuments } from './career-documents';
import { languageTranslation } from './language-translation';

export const LIBRARY_SKILLS: Skill[] = [
  landingPageCreation,
  uiUxBestPractices,
  fullstackDevelopment,
  backendApiDesign,
  databaseOptimization,
  codeReviewDebugging,
  seoOptimization,
  copywritingMarketing,
  technicalWriting,
  dataAnalysis,
  imageGenerationPrompting,
  videoScriptWriting,
  socialMediaContent,
  businessStrategy,
  careerDocuments,
  languageTranslation,
];
