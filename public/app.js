// Entry module. The client is split into ES modules under /js; this file loads them all and then
// runs their __boot_* functions in the original single-file order, once every module has
// evaluated — so a module can import any other freely (cycles included) without a top-level
// statement ever observing a binding that has not been initialised yet.
import { __boot_core_1 } from "./js/core.js";
import { __boot_base_1 } from "./js/base.js";
import "./js/data.js";
import "./js/markets.js";
import "./js/corr.js";
import { __boot_drawer_3163 } from "./js/drawer.js";
import "./js/prefs.js";
import { __boot_alerts_3533 } from "./js/alerts.js";
import "./js/admin.js";
import "./js/positioning.js";
import { __boot_backtest_6465 } from "./js/backtest.js";
import { __boot_charts_6690 } from "./js/charts.js";
import "./js/triggers.js";
import "./js/actionable.js";
import { __boot_calendar_7810 } from "./js/calendar.js";
import { __boot_notes_8010 } from "./js/notes.js";
import { __boot_trend_8880 } from "./js/trend.js";
import "./js/sectors.js";
import { __boot_nav_10165, __boot_nav_10228, __boot_nav_10422, __boot_nav_10545, __boot_nav_10554, __boot_nav_10590, __boot_nav_10612, __boot_nav_10624, __boot_nav_10845 } from "./js/nav.js";
import { __boot_terminal_10926, __boot_terminal_11651 } from "./js/terminal.js";
import { __boot_report_12113 } from "./js/report.js";
import "./js/focus.js";
import "./js/funds.js";
import { __boot_insiders_13850 } from "./js/insiders.js";
import { __boot_messages_14817 } from "./js/messages.js";
import "./js/access.js";

__boot_core_1();
__boot_base_1();
__boot_drawer_3163();
__boot_alerts_3533();
__boot_backtest_6465();
__boot_charts_6690();
__boot_calendar_7810();
__boot_notes_8010();
__boot_trend_8880();
__boot_nav_10165();
__boot_nav_10228();
__boot_nav_10422();
__boot_nav_10545();
__boot_nav_10554();
__boot_nav_10590();
__boot_nav_10612();
__boot_nav_10624();
__boot_nav_10845();
__boot_terminal_10926();
__boot_terminal_11651();
__boot_report_12113();
__boot_insiders_13850();
__boot_messages_14817();
