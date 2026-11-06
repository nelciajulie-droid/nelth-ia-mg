import type { Skill } from '../types'

export const dataAnalysis: Skill = {
  name: 'data-analysis',
  description:
    'Data analysis methodology: question-first workflow, data cleaning checklist (duplicates, missing values, type coercion, outliers), statistical pitfalls (correlation vs causation, survivorship bias, Simpson paradox, p-hacking), chart-type selection table and insight communication (observation + interpretation + recommended action). Use when the user provides data or asks to analyse des donnees, explore a dataset, build or read a dashboard, interpret metrics, or choose the right chart.',
  keywords: [
    'analyse de donnees', 'data analysis', 'donnees', 'data', 'statistiques',
    'stats', 'analyse', 'graphique', 'graphiques', 'chart', 'charts',
    'visualisation', 'visualization', 'dashboard', 'tableau de bord', 'kpi',
    'indicateurs', 'nettoyage de donnees', 'data cleaning', 'valeurs manquantes',
    'missing values', 'doublons', 'outliers', 'valeurs aberrantes',
    'correlation', 'causation', 'tendance', 'trend', 'insight',
    'analyse statistique'
  ],
  body: `# Data Analysis

## Workflow (never skip the order)
1. Question: state the decision the analysis serves in one sentence ("Should we raise prices on plan X?"). No question, no analysis — only description.
2. Clean: run the cleaning checklist before looking for any insight.
3. Explore: distributions, missingness, cardinalities, time ranges. Describe before you model.
4. Analyze: use the smallest technique that answers the question — a simple split often beats a model.
5. Communicate: one chart + one insight sentence + one recommended action.

## Cleaning checklist
- Duplicates: exact duplicates and logical ones (same order id in two rows); decide keep-first, and write down why.
- Missing values: quantify the rate per column. Under 5%: impute (median/mode). 5-40%: impute with a missing flag or analyze the segment separately. Over 40%: question the data source before filling anything. Never fill with 0 unless zero is a real value.
- Type coercion: dates parsed to ISO, numbers stripped of currency symbols and spaces, strings trimmed; verify unit consistency (ms vs s, EUR vs kEUR).
- Outliers: flag with the IQR rule (1.5x) or z-score > 3, then investigate each one — cap only with a documented business reason, never silently drop.

## Statistical pitfalls
- Correlation is not causation: before claiming a cause, look for a confounder that moves both variables.
- Survivorship bias: ask what is missing because it failed early (churned users, delisted products, rejected applicants).
- Simpson's paradox: check the trend inside each segment before trusting the aggregate.
- p-hacking: fix the hypothesis before testing, one primary metric per question, report effect sizes and confidence intervals — not only significance.
- Small denominators: any rate computed on fewer than ~30 events carries a warning label.

## Chart-type selection table
- Comparison between categories -> bar chart, sorted by value, never alphabetically.
- Trend over time -> line chart; time on the x axis; aggregate to the meaningful grain (day, week, month).
- Part-of-whole -> stacked bar, or a donut only with <= 5 slices and clearly unequal shares; otherwise a plain bar of the values.
- Distribution -> histogram (try several bin widths) or boxplot per group.
- Relationship between two measures -> scatter plot + trend line; color encodes at most one third dimension.
- Banned: 3D charts, dual y axes, truncated y axis on bar charts.

## Stating insights
Use the formula: observation (number + comparison) + interpretation (cause, explicitly labeled as a hypothesis) + recommended action (with owner and next step).
- "Checkouts fell 18% week-over-week after the March 12 release (observation). The new mobile payment step is the likely cause (interpretation). Roll it back on mobile and monitor for 7 days (action)."
- Every chart title states the takeaway, not the variable names ("Carts abandoned at step 3, not step 1").`
}

export default dataAnalysis
