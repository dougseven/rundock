'use strict';
// Reading Dashboard UI entry: the generic-framework proof plugin. Registers
// one route, reads and writes its one resource through the host's generic
// protocol context, and touches nothing that assumes anything about what a
// "plugin" is for. Loaded as a classic script over /plugins/reading-dashboard/...,
// so it runs in the page, not as a module: RundockPluginHost is a global.
(function () {
  var currentEtag = null;

  RundockPluginHost.register('reading-dashboard', {
    routes: {
      library: {
        mount: function (container, context) {
          render(container, context, { books: [] }, 'Loading...');
          context.getResource('reading-list').then(function (result) {
            currentEtag = result.etag;
            render(container, context, result.document, null);
          }).catch(function (e) {
            container.textContent = 'Could not load the reading list: ' + e.message;
          });
        },
        unmount: function () {},
      },
    },
  });

  function render(container, context, doc, notice) {
    var books = doc.books || [];
    var html = '<div data-plugin-id="reading-dashboard" class="reading-dashboard">';
    html += '<h2>Reading List</h2>';
    if (notice) html += '<p class="reading-notice">' + context.escapeHtml(notice) + '</p>';
    html += '<ul class="reading-book-list">';
    for (var i = 0; i < books.length; i++) {
      html += '<li>' + context.escapeHtml(books[i].title) + '</li>';
    }
    html += '</ul>';
    html += '<input type="text" class="reading-add-input" placeholder="Book title">';
    html += '<button type="button" class="reading-add-btn">Add</button>';
    html += '</div>';
    container.innerHTML = html;

    container.querySelector('.reading-add-btn').addEventListener('click', function () {
      var input = container.querySelector('.reading-add-input');
      var title = input.value.trim();
      if (!title) return;
      var next = { books: books.concat([{ title: title }]) };
      context.replaceResource('reading-list', currentEtag, next).then(function (result) {
        currentEtag = result.etag;
        render(container, context, result.document, null);
      }).catch(function (e) {
        if (e.conflict) {
          currentEtag = e.etag;
          render(container, context, e.document, 'Someone else changed the list. Try again.');
        } else {
          render(container, context, doc, 'Could not save: ' + e.message);
        }
      });
    });
  }
})();
