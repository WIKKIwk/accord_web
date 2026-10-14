# Manufacturing dashboard visual review

Historical comparison notes are retained below for traceability. Current genuine source, purposeful route distribution, exact queue-dot scale and user-timezone date acceptance are committed in `168c2c9` and supersede earlier presentation/source-port conclusions. Use [DASHBOARDCN_CHECKPOINT.md](DASHBOARDCN_CHECKPOINT.md) and [CURRENT_ACCEPTANCE.md](CURRENT_ACCEPTANCE.md) for the accepted current state. The supplied reference image files remain private local inputs and are not committed.

Review date: 2026-10-13. Independent review of supplied local pixels. Application source is owned by the implementation agent; this reviewer edits only this document. Existing theme colors are a fixed constraint. Dark reference backgrounds do not authorize a palette change, decorative gradients or additional accent colors.

## Reviewed images

All six reference files and both baseline captures were opened with the image viewer, rather than inferred from filenames or implementation code.

| Reference | Actual image size | Observed composition |
| --- | --- | --- |
| [184813](reference-inputs/dashboard-restyle/image(20261013-184813).png) | 2048 × 1536 | Two compact process panels. The left uses a timestamp column, continuous vertical rail, boundary dots, thick rounded interval marks and phase headings. The right uses a substantial horizontal segmented duration band, aligned task/duration/timestamp rows and a dominant total duration. |
| [184814](reference-inputs/dashboard-restyle/image(20261013-184814).png) | 2048 × 1536 | Enlarged vertical rail: thin connector, round boundaries, thick active segment, subdued historical annotation, monospace time labels, readable task names. |
| [184815](reference-inputs/dashboard-restyle/image(20261013-184815).png) | 2048 × 1536 | Enlarged horizontal band: unequal segment widths, generous segment height, rounded ends, narrow gaps, phase labels above and boundary times below. |
| [184817](reference-inputs/dashboard-restyle/image(20261013-184817).png) | 531 × 306 | Low-profile ruler with major/minor ticks, restrained labels, highlighted event stems and a tooltip physically anchored near its selected marker. |
| [184818](reference-inputs/dashboard-restyle/image(20261013-184818).png) | 865 × 399 | One large summary value over a wide thin-stroke chart. Quiet horizontal guides, narrow crosshair, local tooltip and selected date pill. |
| [184820](reference-inputs/dashboard-restyle/image(20261013-184820).png) | 1279 × 642 | Integrated dashboard surface: compact metric band with dividers, broad primary chart, narrower secondary column, segmented radial/linear indicators and clear number hierarchy. |

Baseline captures have the same 1600 × 1250 viewport:

- [Dashboard before](deliverables/before-dashboard-restyle/accord-demo-manufacturing-time-dashboard.png)
- [History ruler before](deliverables/before-dashboard-restyle/accord-demo-manufacturing-history-ruler.png)

These are representative synthetic captures, not production facts or an exhaustive dataset. The visible baseline contains one loaded closed order and only one stage with matched duration evidence; empty chart regions cannot be filled with invented orders or stages.

## Baseline pixel findings

The reported style mismatch is supported by the captures. The baseline uses successive bordered cards and nested cards, with controls and explanation blocks taking more visual space than the time representation. Existing colors are appropriate; changing the background alone would not correct the composition.

| ID | Actual baseline difference | Required visual direction for comparison |
| --- | --- | --- |
| V01 Composition | Four separate KPI cards, two large overview cards, a large order-selection card and a nested timeline card fragment the page. | Use a connected analytical surface and compact metric band with quiet dividers. Preserve necessary controls and exact scope text while reducing repeated wrappers. |
| V02 Number hierarchy | Small equal-weight KPI values dominate the first row equally; no duration or coverage value acts as the visual anchor. | Give one defensible observed duration or coverage metric a larger type scale and immediate qualifier. Secondary counts remain smaller. Do not promote elapsed time to productive work. |
| V03 Density | The longest-stage panel has a single short row followed by a large blank area; its height follows the neighboring queue panel. | Make sparse data intentional: compact ranking rows or a clearly labelled analytical region, rather than an oversized empty card. Never fabricate additional samples to achieve density. |
| V04 Segmented duration | Stage tracks are narrow, low-emphasis strips. Most of the detail surface is headings, explanation, filters and borders. | Give actual recorded intervals a substantial rounded segmented band. Segment widths and gaps must follow real boundaries on a common scale; unknown intervals stay unmeasured. |
| V05 Vertical rail | The shown stage-detail capture is a table of horizontal tracks; it does not show the reference's timestamp/rail/task/duration composition. | Provide a visible event rail with timestamp column, continuous connector, boundary dots and phase/stage context using existing retained events. The rail should remain useful without hover. |
| V06 Ruler | The history ruler is a hairline with sparse circles and labels; its visual rhythm differs substantially from the dense reference tick ladder. | Align major and minor ticks to the actual time domain, distinguish tick hierarchy and show the selected marker/stem clearly. Tick marks represent scale, not fabricated events. |
| V07 Selected event | A full-width selected-event box sits below the ruler rather than being attached to the selected marker. | Place event detail near its marker with a visible anchor, clamp it inside the available viewport, and support selection by keyboard/click/touch as well as pointer hover. |
| V08 Chart | The baseline overview contains ranking bars and lists, but no thin-stroke chart composition comparable to the last two references. | If an existing input supports a meaningful chart, give it a quiet stroke, consistent units/domain and restrained guides. Do not invent trend samples, equal-volume comparisons or historical deltas. |
| V09 Tonal restraint | The baseline preserves the current neutral theme. The references use few tones; their semantic accents have specific meanings. | Preserve existing theme tokens and functional semantic colors. Avoid multicolor stage categories and gradients, including copying the reference area-chart gradient. |
| V10 Reading order | Summary cards, caveat rows, panel subtitles, selector controls, nested summary cards and filter blocks delay the time history itself. | Keep provenance visible but concise; place controls and details where they support the primary time surface. Exact unknown/hold/cohort disclosures must remain available. |

## After-comparison acceptance

At baseline review, rendered after captures were pending. Source changes, static-render tests and reported test counts do not establish visual equivalence. The dated comparisons below record only after pixels actually opened by this reviewer.

Compare the same viewport and representative data/state. Record the screenshot path, source checkpoint and state used; identify any difference in selected order, clock, stage coverage or scroll position before attributing it to style.

1. Dashboard: integrated composition, dominant qualified value, compact secondary metrics, purposeful handling of sparse data, preserved theme palette.
2. Order detail: broad rounded segments, aligned phase/boundary labels, genuine vertical event rail, explicit unmeasured stages and current global hold.
3. History: major/minor ticks, selected marker and physically anchored tooltip; no overlap, clipping or horizontal spill at either axis endpoint.
4. Interaction: keyboard focus and selected event remain visible; touch selection does not require hover; history can scroll without trapping the page. Narrow layouts retain readable names and time labels.
5. Semantics: no productive-time/OEE/efficiency label, fabricated historical comparison or measured unknown interval introduced for visual similarity. Closed-order cohort and live snapshot/lineage boundaries remain stated.

## Rendered first-pass comparison

Opened these actual after pixels independently:

- [Light dashboard, 1600 × 1250](dashboard-reference-pass/first/dashboard-light-1600x1250.png)
- [Dark dashboard surface](dashboard-reference-pass/first/dashboard-surface-dark.png)
- [Dark ruler, 1600 × 1250](dashboard-reference-pass/first/history-ruler-dark-1600x1250.png)
- [Light event rail, 1600 × 1250](dashboard-reference-pass/first/history-event-rail-light-1600x1250.png)
- [Dark mobile history, 390 × 844](dashboard-reference-pass/first/history-dark-mobile-390x844.png)

Integration-owner checkpoint: `1693f49` plus four styled manufacturing-time files, immutable preview5186 bundle `ManufacturingTimePage-B7wawMi3`. This is the first pass, before the owner's subsequent singleton-axis alignment correction. Both baseline and desktop after show the representative order #4001, one measured stage out of three and an 8-minute-20-second records window. Capture clocks differ; the zoomed ruler starts at 12:04:10 in both inspected ruler views. Dark and mobile after views have no matching baseline theme/viewport here, so they establish visible layout observations rather than a numerical pixel-diff score.

| IDs | Observed after result | Remaining comparison limits |
| --- | --- | --- |
| V01/V02 | Substantially closer: shared four-metric band, restrained dividers, integrated overview surface and visibly dominant qualified duration. The history window also has strong hierarchy while retaining its first/last-record qualifier. | These are observed structural improvements, not exact duplication of the commercial dashboard or its metrics. |
| V03 | Ranking and queue regions now share an analytical surface; the narrow queue column has compact names, counts and restrained tracks. | The primary chart still has generous empty area around its single real observation. That data scarcity must remain honest; a fabricated curve is unacceptable. |
| V04 | Actual intervals have broad rounded segments; process and stop use two theme tones. Unknown stages remain explicit unmeasured rows, without fabricated intervals. | The inspected dataset demonstrates one measured stage only, not every overlap/uncertainty layout. |
| V05 | A real timestamp/event rail is visible with stage heading, connector and event dots. | The inspected light rail shows a thin connector/dots; the thick rounded vertical interval marks and aligned duration column in 184813/184814 are not visible. Treat this aspect as partial fidelity. |
| V06/V07 | Dense major/minor tick rhythm, selected endpoint stem and clamped nearby tooltip are visibly present. Mobile tooltip remains inside the shown width. Selected detail is integrated into the same surface. | Screenshots do not prove touch or keyboard behavior; those require separate interaction evidence. |
| V08 | Quiet duration guides, crosshair, local tooltip and a genuine isolated data point are present, with a nonchronological ranking qualifier. | Confirmed first-pass alignment defect: singleton rank pill sits at the left while its point/crosshair is centered. Owner's fix is pending a new capture; it is not resolved by source/test reports here. |
| V09 | Existing neutral light/dark theme tones remain intact; no decorative gradients or multicolor stage palette are visible. | A dark-theme screenshot is not permission to change the user's existing default palette. |
| V10 | Source notes use quiet inline rules rather than repeated Card/Alert stacks. | History remains below the first dashboard viewport because the main chart is tall. On the inspected 390 × 844 capture, the fixed demo badge overlaps the lower tabs/legend area. This is a visible overlap, not a tested touch failure. |

Status: **first after-pixel comparison complete; closer composition confirmed, exact equivalence not claimed**. Singleton label alignment and mobile demo-overlay placement need subsequent visual evidence. The event-rail interval-mark difference remains recorded. No application source was changed for this visual review.

## Refined rendered comparison

The following nine refined captures were opened independently. They retain the earlier first-pass evidence above; the subsequent fixes do not alter what that earlier capture showed.

Original singleton fixture:

- [Light dashboard, 1600 × 1250](dashboard-reference-pass/refined/dashboard-light-1600x1250.png)
- [Dark dashboard surface](dashboard-reference-pass/refined/dashboard-surface-dark.png)
- [Dark ruler, 1600 × 1250](dashboard-reference-pass/refined/history-ruler-dark-1600x1250.png)
- [Light event rail, 1600 × 1250](dashboard-reference-pass/refined/history-event-rail-light-1600x1250.png)
- [Dark mobile history, 390 × 844](dashboard-reference-pass/refined/history-dark-mobile-390x844.png)

Expanded fixture cohort:

- [Light dashboard, 1600 × 1250](dashboard-reference-pass/refined-cohort/dashboard-light-1600x1250.png)
- [Dark dashboard surface](dashboard-reference-pass/refined-cohort/dashboard-surface-dark.png)
- [Dark mobile dashboard, 390 × 844](dashboard-reference-pass/refined-cohort/dashboard-dark-mobile-390x844.png)
- [Light event rail, 1600 × 1250](dashboard-reference-pass/refined-cohort/history-event-rail-light-1600x1250.png)

The integration owner's [singleton metadata](dashboard-reference-pass/refined/capture-evidence.json) dates the capture to `2026-10-13T19:47:00.151Z`; [expanded-cohort metadata](dashboard-reference-pass/refined-cohort/capture-evidence.json) dates it to `2026-10-13T19:47:03.056Z`. Both identify source `4423a3d + refined representative dashboard`, immutable local preview 5186 and fixture origin 5199. They explicitly state `synthetic: true` and `productionVerified: false`. The captured view clock differs from the baseline; selected order #4001 retains its 8-minute-20-second records window, one measured stage out of three and seven retained events.

The original fixture is the controlled data comparison with the baseline. The opt-in cohort adds eight native-shaped synthetic closed histories, for nine loaded histories and a ranking limited to eight stage observations. Its denser plot demonstrates layout with multiple records; the additional data cannot be attributed to styling or treated as actual factory history. In that cohort's detail capture, the selected order is still the original #4001.

| IDs | Refined pixel result | Scoped acceptance and limits |
| --- | --- | --- |
| V01/V02/V10 | Integrated metric band, large qualified duration, narrow queue rail and concise provenance remain visible in both themes. Demo labels now sit in the normal heading flow. | The first-pass mobile badge overlap is visibly resolved in the inspected history crop; tabs and legend remain unobscured. This does not certify every narrow viewport or every translated label. |
| V03/V08 | In the original singleton dashboard, the rank pill now sits directly below the centered point/crosshair. The expanded cohort has a quiet, thin-stroke plot of eight descending observed durations, aligned ordinal labels and local selection tooltip. | The first-pass singleton alignment defect is visibly resolved. The plot is an explicitly labelled ranking, not a chronological trend. Sparse original data still produces one point; no curve or extra samples are fabricated for similarity. |
| V04/V06/V07 | Broad rounded horizontal intervals, dense major/minor ruler ticks and the selected endpoint's nearby tooltip/stem remain visible. The mobile tooltip is clamped within the shown width. | Closer to references 184815/184817. Unknown stages remain unmeasured. Visible tooltip containment establishes this captured endpoint/layout only. |
| V05 | The light event rail now shows substantial rounded interval marks beside timestamped boundaries, stage heading and a right-aligned duration column. Visible exact values include 1 minute 40 seconds, 50 seconds, 1 minute 40 seconds and 50 seconds. | The first-pass missing thick-mark/duration-column difference is visibly resolved for the validated adjacent intervals shown, closer to 184813/184814. The rail uses regular event-row spacing; vertical length is not a proportional duration axis. The horizontal ruler provides the actual time scale. No invented previous-period annotation is added. |
| V09 | Neutral light/dark tones and restrained stroke/segment contrast remain visible across the inspected captures. | The user's existing palette is preserved. There is no copied area gradient, decorative accent palette or multicolor stage coding. |
| Responsive layout | The inspected 390 × 844 history retains readable controls, time labels and selected detail without the old overlay. The expanded dashboard uses a contained two-column metric grid. | No horizontal spill is visible. The mobile dashboard crop ends near its dominant value, so this reviewer does not claim to have inspected its entire ranking plot at that viewport. |

Capture metadata reports settled finite transitions, zero remaining finite animations, Home/End navigation, zoom, no page overflow, no page errors and no outside requests. Those are integration-owner browser results; this reviewer independently inspected pixels rather than rerunning those interactions. Touch selection, additional viewport/state combinations and human acceptance remain separate from this visual comparison.

Status: **refined after-pixel comparison complete; the three specific first-pass defects are visibly resolved in the inspected captures**. Composition, hierarchy, segment treatment, event rail, ruler and anchored tooltip are materially closer to all six references while preserving data qualifiers and the existing palette. Exact visual equivalence, productive-time metrics, complete historical coverage and production readiness are not claimed. No application source was changed for this review.
