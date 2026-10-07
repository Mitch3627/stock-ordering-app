// Adds an Edit / Done button to the top bar. While editing, pages make their numbers and names editable in
// place (a banner says so). Pages listen for the "editmodechange" event and re-render.
(function () {
  window.isEditing = () => document.body.classList.contains('editing');

  window.addEventListener('DOMContentLoaded', () => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary btn-sm edit-toggle manager-only'; // correcting saved records is for managers
    const paint = (on) => {
      btn.innerHTML = window.icon ? `${window.icon(on ? 'check' : 'edit', 'icon-sm')}<span>${on ? 'Done' : 'Edit'}</span>` : (on ? 'Done' : 'Edit');
      btn.title = on ? 'Finish editing' : 'Edit the numbers and names on this page';
      btn.setAttribute('aria-pressed', String(on));
    };
    btn.addEventListener('click', () => {
      const on = !window.isEditing();
      document.body.classList.toggle('editing', on);
      btn.classList.toggle('active', on);
      paint(on);
      window.dispatchEvent(new CustomEvent('editmodechange', { detail: { editing: on } }));
    });
    paint(false);
    (document.getElementById('slot-edit') || document.body).appendChild(btn);
  });
})();
