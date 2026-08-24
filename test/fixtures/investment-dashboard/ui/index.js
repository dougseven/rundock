'use strict';
// Investment Partner Hub UI entry: the reference plugin. Everything the
// spec's "Dashboard UI" section lists lives in this one file because a
// manifest declares exactly one ui.entry (no plugin-authored module system);
// section comments below mark where each requirement is met.
//
// No investment-specific behaviour exists anywhere outside this package: no
// core module knows what a "position" or a "thesis" is. Every read and
// write goes through the generic mount context (getResource/replaceResource),
// the same protocol test/fixtures/reading-dashboard/ui/index.js uses.
(function () {
  var STALE_MS = 24 * 60 * 60 * 1000;
  var ACTIONS = ['buy', 'sell', 'hold', 'watch', 'avoid'];
  var STATUSES = ['proposed', 'approved', 'executed', 'rejected', 'archived'];

  // Per-resource cache: { document, etag }. Shared between the portfolio
  // route and the chat-side-panel slot so either can read what the other
  // just wrote without a round trip, though each writes only its own data.
  var cache = { 'portfolio-state': null, 'risk-profile': null, 'decision-journal': null };
  var portfolioUnsub = null;
  var sidePanelUnsub = null;

  RundockPluginHost.register('investment-dashboard', {
    routes: {
      portfolio: {
        mount: function (container, context) { mountPortfolio(container, context); },
        unmount: function () { unmountPortfolio(); },
      },
    },
    slots: {
      'risk-controls': {
        mount: function (container, context) { mountSidePanel(container, context); },
        unmount: function () { unmountSidePanel(); },
      },
    },
  });

  // ---------------------------------------------------------------------
  // Data loading, shared by both mounts.
  // ---------------------------------------------------------------------

  function loadAll(context) {
    return Promise.all([
      context.getResource('portfolio-state'),
      context.getResource('risk-profile'),
      context.getResource('decision-journal'),
    ]).then(function (results) {
      cache['portfolio-state'] = results[0];
      cache['risk-profile'] = results[1];
      cache['decision-journal'] = results[2];
    });
  }

  function save(context, resourceId, nextDocument) {
    var current = cache[resourceId];
    return context.replaceResource(resourceId, current ? current.etag : null, nextDocument).then(function (result) {
      cache[resourceId] = result;
      return result;
    });
  }

  // ---------------------------------------------------------------------
  // Portfolio math: every number the allocation charts, concentration
  // indicators, and stale-price flag need, computed once from the raw
  // resource so the render functions stay pure display code.
  // ---------------------------------------------------------------------

  function marketValue(position) {
    if (!position.currentPrice) return 0;
    return position.quantity * position.currentPrice.amount;
  }

  function isStale(position) {
    if (!position.currentPrice || !position.currentPrice.asOf) return false;
    var age = Date.now() - new Date(position.currentPrice.asOf).getTime();
    return age > STALE_MS;
  }

  function allPositions(portfolio) {
    var out = [];
    (portfolio.accounts || []).forEach(function (account) {
      (account.positions || []).forEach(function (position) {
        out.push({ account: account, position: position });
      });
    });
    return out;
  }

  function totalCash(portfolio) {
    return (portfolio.accounts || []).reduce(function (sum, a) { return sum + (a.cashBalance || 0); }, 0);
  }

  function totalMarketValue(portfolio) {
    return allPositions(portfolio).reduce(function (sum, p) { return sum + marketValue(p.position); }, 0) + totalCash(portfolio);
  }

  function groupSum(portfolio, keyFn) {
    var totals = {};
    allPositions(portfolio).forEach(function (p) {
      var key = keyFn(p);
      totals[key] = (totals[key] || 0) + marketValue(p.position);
    });
    return totals;
  }

  function largestSinglePositionFraction(portfolio, total) {
    if (total <= 0) return 0;
    var max = 0;
    allPositions(portfolio).forEach(function (p) {
      var f = marketValue(p.position) / total;
      if (f > max) max = f;
    });
    return max;
  }

  function largestSectorFraction(portfolio, total) {
    if (total <= 0) return 0;
    var sectors = groupSum(portfolio, function (p) { return p.position.sector; });
    var max = 0;
    Object.keys(sectors).forEach(function (s) { if (sectors[s] / total > max) max = sectors[s] / total; });
    return max;
  }

  function cashReserveFraction(portfolio, total) {
    if (total <= 0) return 0;
    return totalCash(portfolio) / total;
  }

  // ---------------------------------------------------------------------
  // Small formatting/DOM helpers.
  // ---------------------------------------------------------------------

  function money(n) { return '$' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
  function pct(fraction) { return ((fraction || 0) * 100).toFixed(1) + '%'; }
  function el(tag, className, html) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  // Hand-built SVG horizontal bar chart: one <rect> per item, proportional
  // to its share of the total. No charting dependency, per the spec.
  function barChartSvg(items, context) {
    var total = items.reduce(function (s, i) { return s + i.value; }, 0);
    var width = 480, barHeight = 22, gap = 6;
    var height = items.length * (barHeight + gap);
    var svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="' + height + '" role="img" aria-label="Allocation chart">';
    items.forEach(function (item, i) {
      var w = total > 0 ? Math.max(2, (item.value / total) * width) : 0;
      var y = i * (barHeight + gap);
      svg += '<rect x="0" y="' + y + '" width="' + w + '" height="' + barHeight + '" rx="4" fill="var(--accent)" opacity="' + (0.4 + 0.6 * ((i + 1) / items.length)) + '"></rect>';
      svg += '<text x="' + (w + 8) + '" y="' + (y + barHeight - 6) + '" font-size="12" fill="var(--text-1)">' + context.escapeHtml(item.label) + ' (' + money(item.value) + ')</text>';
    });
    svg += '</svg>';
    return svg;
  }

  // Plain-DOM concentration/reserve indicator: current fraction as a width
  // bar against its constraint, with a threshold marker. Deliberately not a
  // second SVG chart type: "hand-built SVG and plain DOM APIs" covers both.
  function indicatorHtml(label, currentFraction, limitFraction, isMinimum, context) {
    var overLimit = isMinimum ? currentFraction < limitFraction : currentFraction > limitFraction;
    var barPct = Math.min(100, currentFraction * 100);
    var limitPct = Math.min(100, limitFraction * 100);
    return '<div class="inv-indicator">' +
      '<div class="inv-indicator-label">' + context.escapeHtml(label) + '<span class="inv-indicator-value' + (overLimit ? ' inv-over' : '') + '">' + pct(currentFraction) + ' of ' + pct(limitFraction) + (isMinimum ? ' min' : ' max') + '</span></div>' +
      '<div class="inv-indicator-track"><div class="inv-indicator-fill' + (overLimit ? ' inv-over' : '') + '" style="width:' + barPct + '%"></div><div class="inv-indicator-limit" style="left:' + limitPct + '%"></div></div>' +
      '</div>';
  }

  // ---------------------------------------------------------------------
  // Portfolio route: overview, positions, risk, journal as sub-sections
  // of the one declared route (the manifest declares exactly one route;
  // this file owns switching between its own sub-views).
  // ---------------------------------------------------------------------

  function mountPortfolio(container, context) {
    container.innerHTML = '<div data-plugin-id="investment-dashboard" class="inv-root"><p class="inv-loading">Loading portfolio…</p></div>';
    loadAll(context).then(function () {
      renderPortfolio(container, context, 'overview');
    }).catch(function (e) {
      container.innerHTML = '<div data-plugin-id="investment-dashboard"><p class="inv-error">Could not load the portfolio: ' + context.escapeHtml(e.message) + '</p></div>';
    });
    portfolioUnsub = context.subscribe('plugin-data-changed', function (change) {
      if (change.pluginId !== 'investment-dashboard') return;
      cache[change.resourceId] = { document: change.document, etag: change.etag };
      var active = container.querySelector('.inv-tab.active');
      renderPortfolio(container, context, active ? active.dataset.tab : 'overview');
    });
  }

  function unmountPortfolio() {
    if (portfolioUnsub) { portfolioUnsub(); portfolioUnsub = null; }
  }

  function renderPortfolio(container, context, activeTab) {
    var portfolio = cache['portfolio-state'].document;
    var risk = cache['risk-profile'].document;
    var journal = cache['decision-journal'].document;
    var total = totalMarketValue(portfolio);

    var html = '<div data-plugin-id="investment-dashboard" class="inv-root">';
    html += '<div class="inv-header"><h1>Investment Hub</h1>' +
      '<button type="button" class="inv-btn inv-btn-primary" data-action="start-lead-partner">Start Lead Partner conversation</button></div>';
    html += '<nav class="inv-tabs">';
    [['overview', 'Overview'], ['positions', 'Positions'], ['risk', 'Risk Profile'], ['journal', 'Decision Journal']].forEach(function (t) {
      html += '<button type="button" class="inv-tab' + (t[0] === activeTab ? ' active' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>';
    });
    html += '</nav><div class="inv-tab-content" id="inv-tab-content"></div></div>';
    container.innerHTML = html;

    container.querySelector('[data-action="start-lead-partner"]').addEventListener('click', function () {
      context.startConversation('lead-partner', null);
    });
    container.querySelectorAll('.inv-tab').forEach(function (btn) {
      btn.addEventListener('click', function () { renderPortfolio(container, context, btn.dataset.tab); });
    });

    var content = container.querySelector('#inv-tab-content');
    if (activeTab === 'overview') renderOverviewTab(content, context, portfolio, risk, total);
    else if (activeTab === 'positions') renderPositionsTab(content, context, portfolio);
    else if (activeTab === 'risk') renderRiskTab(content, context, risk);
    else if (activeTab === 'journal') renderJournalTab(content, context, journal);
  }

  // -- Overview: allocation by asset class/sector/account, concentration
  //    and cash-reserve indicators. --
  function renderOverviewTab(content, context, portfolio, risk, total) {
    var byAssetClass = groupSum(portfolio, function (p) { return p.position.assetClass; });
    var bySector = groupSum(portfolio, function (p) { return p.position.sector; });
    var byAccount = {};
    (portfolio.accounts || []).forEach(function (a) {
      byAccount[a.name] = (a.positions || []).reduce(function (s, p) { return s + marketValue(p); }, 0) + (a.cashBalance || 0);
    });

    var toItems = function (totals) {
      return Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; }).map(function (k) { return { label: k, value: totals[k] }; });
    };

    var html = '<div class="inv-card"><h2>Total value: ' + money(total) + '</h2></div>';
    html += '<div class="inv-card"><h3>By asset class</h3>' + barChartSvg(toItems(byAssetClass), context) + '</div>';
    html += '<div class="inv-card"><h3>By sector</h3>' + toItems(bySector).map(function (i) {
      return indicatorHtml(i.label, total > 0 ? i.value / total : 0, 1, false, context);
    }).join('') + '</div>';
    html += '<div class="inv-card"><h3>By account</h3>' + toItems(byAccount).map(function (i) {
      return indicatorHtml(i.label, total > 0 ? i.value / total : 0, 1, false, context);
    }).join('') + '</div>';
    html += '<div class="inv-card"><h3>Concentration and reserve</h3>' +
      indicatorHtml('Largest single position', largestSinglePositionFraction(portfolio, total), risk.constraints.maximumSinglePositionFraction, false, context) +
      indicatorHtml('Largest sector', largestSectorFraction(portfolio, total), risk.constraints.maximumSectorFraction, false, context) +
      indicatorHtml('Cash reserve', cashReserveFraction(portfolio, total), risk.constraints.minimumCashReserveFraction, true, context) +
      '</div>';
    content.innerHTML = html;
  }

  // -- Positions: manual position and price editor. --
  function renderPositionsTab(content, context, portfolio) {
    var rows = '';
    allPositions(portfolio).forEach(function (p, i) {
      var pos = p.position;
      rows += '<tr' + (isStale(pos) ? ' class="inv-stale"' : '') + '>' +
        '<td>' + context.escapeHtml(pos.ticker) + '</td>' +
        '<td>' + context.escapeHtml(p.account.name) + '</td>' +
        '<td><input type="number" min="0" step="any" class="inv-input inv-qty" data-index="' + i + '" value="' + pos.quantity + '" aria-label="Quantity for ' + context.escapeHtml(pos.ticker) + '"></td>' +
        '<td><input type="number" min="0" step="any" class="inv-input inv-price" data-index="' + i + '" value="' + pos.currentPrice.amount + '" aria-label="Current price for ' + context.escapeHtml(pos.ticker) + '"></td>' +
        '<td>' + money(marketValue(pos)) + (isStale(pos) ? ' <span class="inv-badge">stale</span>' : '') + '</td>' +
        '</tr>';
    });
    var html = '<div class="inv-card"><h3>Positions</h3>';
    html += '<table class="inv-table"><thead><tr><th scope="col">Ticker</th><th scope="col">Account</th><th scope="col">Quantity</th><th scope="col">Price (USD)</th><th scope="col">Market value</th></tr></thead><tbody>' + rows + '</tbody></table>';
    html += (allPositions(portfolio).length === 0 ? '<p class="inv-empty">No positions yet.</p>' : '');
    html += '<div class="inv-caption">Prices are manual, single-currency (USD), and shown stale after 24 hours. Edit a value and press Save.</div>';
    html += '<button type="button" class="inv-btn inv-btn-primary" data-action="save-positions">Save</button>';
    html += '</div>';
    content.innerHTML = html;

    content.querySelector('[data-action="save-positions"]').addEventListener('click', function () {
      var flat = allPositions(portfolio);
      content.querySelectorAll('.inv-qty').forEach(function (input) {
        flat[Number(input.dataset.index)].position.quantity = parseFloat(input.value) || 0;
      });
      content.querySelectorAll('.inv-price').forEach(function (input) {
        var entry = flat[Number(input.dataset.index)];
        entry.position.currentPrice.amount = parseFloat(input.value) || 0;
        entry.position.currentPrice.asOf = new Date().toISOString();
      });
      save(context, 'portfolio-state', portfolio).then(function () {
        renderPositionsTab(content, context, cache['portfolio-state'].document);
      }).catch(function (e) { showSaveError(content, e); });
    });
  }

  // -- Risk: native range/numeric controls for the three constraints. --
  function renderRiskTab(content, context, risk) {
    var c = risk.constraints;
    var field = function (id, label, value) {
      return '<div class="inv-field">' +
        '<label for="' + id + '">' + label + '</label>' +
        '<div class="inv-field-row">' +
        '<input type="range" id="' + id + '" min="0" max="1" step="0.01" value="' + value + '" aria-describedby="' + id + '-value">' +
        '<span id="' + id + '-value" class="inv-field-value">' + pct(value) + '</span>' +
        '</div></div>';
    };
    var html = '<div class="inv-card"><h3>Risk constraints</h3>' +
      field('inv-max-position', 'Maximum single-position fraction', c.maximumSinglePositionFraction) +
      field('inv-max-sector', 'Maximum sector fraction', c.maximumSectorFraction) +
      field('inv-min-cash', 'Minimum cash reserve fraction', c.minimumCashReserveFraction) +
      '<div class="inv-field"><label for="inv-tax-pref"><input type="checkbox" id="inv-tax-pref"' + (risk.taxPreferences.preferTaxAdvantagedForDividends ? ' checked' : '') + '> Prefer tax-advantaged accounts for dividend-paying positions</label></div>' +
      '<button type="button" class="inv-btn inv-btn-primary" data-action="save-risk">Save</button>' +
      '</div>';
    content.innerHTML = html;

    ['inv-max-position', 'inv-max-sector', 'inv-min-cash'].forEach(function (id) {
      var input = content.querySelector('#' + id);
      input.addEventListener('input', function () {
        content.querySelector('#' + id + '-value').textContent = pct(parseFloat(input.value));
      });
    });
    content.querySelector('[data-action="save-risk"]').addEventListener('click', function () {
      var next = {
        constraints: {
          maximumSinglePositionFraction: parseFloat(content.querySelector('#inv-max-position').value),
          maximumSectorFraction: parseFloat(content.querySelector('#inv-max-sector').value),
          minimumCashReserveFraction: parseFloat(content.querySelector('#inv-min-cash').value),
        },
        taxPreferences: {
          preferTaxAdvantagedForDividends: content.querySelector('#inv-tax-pref').checked,
        },
      };
      if (next.constraints.minimumCashReserveFraction >= 1) {
        showSaveError(content, new Error('Minimum cash reserve must stay below 100%.'));
        return;
      }
      save(context, 'risk-profile', next).then(function () {
        renderRiskTab(content, context, cache['risk-profile'].document);
      }).catch(function (e) { showSaveError(content, e); });
    });
  }

  // -- Decision journal: columns by status, following the kanban-like
  //    grouping-by-column pattern without a drag-and-drop dependency
  //    (status changes through the select in each card instead). --
  function renderJournalTab(content, context, journal) {
    var html = '<div class="inv-journal-board">';
    STATUSES.forEach(function (status) {
      var entries = (journal.entries || []).filter(function (e) { return e.status === status; });
      html += '<div class="inv-journal-column"><h3>' + status[0].toUpperCase() + status.slice(1) + ' (' + entries.length + ')</h3>';
      entries.forEach(function (entry) {
        html += '<div class="inv-journal-card">' +
          '<div class="inv-journal-card-title">' + context.escapeHtml(entry.ticker) + ': ' + context.escapeHtml(entry.action) + '</div>' +
          '<div class="inv-journal-card-thesis">' + context.escapeHtml(entry.thesis || '') + '</div>' +
          '<label class="inv-journal-status-label">Status<select class="inv-journal-status" data-id="' + context.escapeHtml(entry.decisionId) + '">' +
          STATUSES.map(function (s) { return '<option value="' + s + '"' + (s === entry.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
          '</select></label>' +
          '</div>';
      });
      html += '</div>';
    });
    html += '</div>';
    content.innerHTML = html;

    content.querySelectorAll('.inv-journal-status').forEach(function (select) {
      select.addEventListener('change', function () {
        var next = JSON.parse(JSON.stringify(journal));
        var entry = next.entries.find(function (e) { return e.decisionId === select.dataset.id; });
        if (!entry) return;
        entry.status = select.value;
        entry.updatedAt = new Date().toISOString();
        save(context, 'decision-journal', next).then(function () {
          renderJournalTab(content, context, cache['decision-journal'].document);
        }).catch(function (e) { showSaveError(content, e); });
      });
    });
  }

  function showSaveError(content, e) {
    var conflict = !!e.conflict;
    var note = el('div', 'inv-error', conflict
      ? 'Someone else changed this since you loaded it. Reload the tab and try again.'
      : 'Could not save: ' + (e.message || 'unknown error'));
    content.insertBefore(note, content.firstChild);
  }

  // ---------------------------------------------------------------------
  // chat-side-panel slot: current constraints and pre-trade impact,
  // mounted only while an investment-plugin agent conversation is active
  // (the host already enforces that eligibility; this only renders once
  // mounted).
  // ---------------------------------------------------------------------

  function mountSidePanel(container, context) {
    container.innerHTML = '<p class="inv-loading">Loading…</p>';
    loadAll(context).then(function () {
      renderSidePanel(container, context);
    }).catch(function (e) {
      container.textContent = 'Could not load risk constraints: ' + e.message;
    });
    sidePanelUnsub = context.subscribe('plugin-data-changed', function (change) {
      if (change.pluginId !== 'investment-dashboard') return;
      cache[change.resourceId] = { document: change.document, etag: change.etag };
      renderSidePanel(container, context);
    });
  }

  function unmountSidePanel() {
    if (sidePanelUnsub) { sidePanelUnsub(); sidePanelUnsub = null; }
  }

  function renderSidePanel(container, context) {
    var portfolio = cache['portfolio-state'].document;
    var risk = cache['risk-profile'].document;
    var total = totalMarketValue(portfolio);
    container.innerHTML = '<div data-plugin-id="investment-dashboard" class="inv-side-panel">' +
      '<h3>Portfolio constraints</h3>' +
      indicatorHtml('Largest single position', largestSinglePositionFraction(portfolio, total), risk.constraints.maximumSinglePositionFraction, false, context) +
      indicatorHtml('Largest sector', largestSectorFraction(portfolio, total), risk.constraints.maximumSectorFraction, false, context) +
      indicatorHtml('Cash reserve', cashReserveFraction(portfolio, total), risk.constraints.minimumCashReserveFraction, true, context) +
      '<p class="inv-caption">A proposed position\'s pre-trade impact on these limits is Lead Partner\'s call to walk through with you before you approve anything.</p>' +
      '</div>';
  }
})();
