(() => {
  const key = 'fish-appearance';
  const root = document.documentElement;

  function apply(value) {
    root.dataset.appearance = value === 'classic' ? 'classic' : 'glass';
    const select = document.getElementById('appearance-style');
    if (select) select.value = root.dataset.appearance;
  }

  try {
    apply(localStorage.getItem(key));
  } catch {
    apply('glass');
  }

  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('appearance-style');
    const help = document.getElementById('appearance-help');
    select.value = root.dataset.appearance;
    select.addEventListener('change', () => {
      apply(select.value);
      try {
        localStorage.setItem(key, root.dataset.appearance);
        help.textContent = '即时生效，保存在当前浏览器。';
      } catch {
        help.textContent = '已切换，当前浏览器无法保存选择。';
      }
    });
  });

  window.addEventListener('storage', event => {
    if (event.key === key) apply(event.newValue);
  });
})();
