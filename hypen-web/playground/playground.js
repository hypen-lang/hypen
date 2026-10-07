var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __moduleCache = /* @__PURE__ */ new WeakMap;
var __toCommonJS = (from) => {
  var entry = __moduleCache.get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function")
    __getOwnPropNames(from).map((key) => !__hasOwnProp.call(entry, key) && __defProp(entry, key, {
      get: () => from[key],
      enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
    }));
  __moduleCache.set(from, entry);
  return entry;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// src/dom/components/column.ts
var exports_column = {};
__export(exports_column, {
  columnHandler: () => columnHandler
});
var columnHandler;
var init_column = __esm(() => {
  columnHandler = {
    create() {
      const el = document.createElement("div");
      el.style.display = "flex";
      el.style.flexDirection = "column";
      el.dataset.hypenType = "column";
      return el;
    }
  };
});

// src/dom/components/row.ts
var exports_row = {};
__export(exports_row, {
  rowHandler: () => rowHandler
});
var rowHandler;
var init_row = __esm(() => {
  rowHandler = {
    create() {
      const el = document.createElement("div");
      el.style.display = "flex";
      el.style.flexDirection = "row";
      el.dataset.hypenType = "row";
      return el;
    }
  };
});

// src/dom/components/text.ts
var exports_text = {};
__export(exports_text, {
  textHandler: () => textHandler
});
var textHandler;
var init_text = __esm(() => {
  textHandler = {
    create() {
      const el = document.createElement("span");
      el.style.display = "inline-block";
      el.dataset.hypenType = "text";
      return el;
    },
    applyProps(el, props) {
      const text = props["0"] || props.text;
      if (text !== undefined) {
        el.dataset.textTemplate = String(text);
        el.textContent = String(text);
      }
    }
  };
});

// src/dom/components/image.ts
var exports_image = {};
__export(exports_image, {
  imageHandler: () => imageHandler
});
var imageHandler;
var init_image = __esm(() => {
  imageHandler = {
    create() {
      const el = document.createElement("img");
      el.dataset.hypenType = "image";
      return el;
    },
    applyProps(el, props) {
      const img = el;
      const src = props["0"] || props.url || props.src;
      if (src !== undefined) {
        img.src = String(src);
      }
      if (props.alt !== undefined) {
        img.alt = String(props.alt);
      }
    }
  };
});

// src/dom/components/button.ts
var exports_button = {};
__export(exports_button, {
  buttonHandler: () => buttonHandler
});
var buttonHandler;
var init_button = __esm(() => {
  buttonHandler = {
    create() {
      const el = document.createElement("button");
      el.dataset.hypenType = "button";
      return el;
    }
  };
});

// src/dom/components/container.ts
var exports_container = {};
__export(exports_container, {
  containerHandler: () => containerHandler
});
var containerHandler;
var init_container = __esm(() => {
  containerHandler = {
    create() {
      const el = document.createElement("div");
      el.dataset.hypenType = "container";
      return el;
    }
  };
});

// src/dom/components/center.ts
var exports_center = {};
__export(exports_center, {
  centerHandler: () => centerHandler
});
var centerHandler;
var init_center = __esm(() => {
  centerHandler = {
    create() {
      const el = document.createElement("div");
      el.style.display = "flex";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.dataset.hypenType = "center";
      return el;
    }
  };
});

// src/dom/components/list.ts
var exports_list = {};
__export(exports_list, {
  listHandler: () => listHandler
});
var listHandler;
var init_list = __esm(() => {
  listHandler = {
    create() {
      const el = document.createElement("div");
      el.style.display = "flex";
      el.style.overflow = "auto";
      el.dataset.hypenType = "list";
      return el;
    },
    applyProps(el, props) {
      const direction = props.direction || props["1"] || "vertical";
      if (direction === "vertical") {
        el.style.flexDirection = "column";
      } else {
        el.style.flexDirection = "row";
      }
      if (props.gap !== undefined) {
        el.style.gap = typeof props.gap === "number" ? `${props.gap}px` : String(props.gap);
      }
    }
  };
});

// src/dom/components/input.ts
var exports_input = {};
__export(exports_input, {
  inputHandler: () => inputHandler
});
var inputHandler;
var init_input = __esm(() => {
  inputHandler = {
    create() {
      const el = document.createElement("input");
      el.dataset.hypenType = "input";
      return el;
    },
    applyProps(el, props) {
      const input = el;
      if (props.type !== undefined) {
        input.type = String(props.type);
      }
      if (props.placeholder !== undefined) {
        input.placeholder = String(props.placeholder);
      }
      if (props.value !== undefined) {
        input.value = String(props.value);
      }
    }
  };
});

// src/dom/components/link.ts
var exports_link = {};
__export(exports_link, {
  linkHandler: () => linkHandler
});
var linkHandler;
var init_link = __esm(() => {
  linkHandler = {
    create() {
      const el = document.createElement("a");
      el.dataset.hypenType = "link";
      return el;
    },
    applyProps(el, props) {
      const anchor = el;
      const href = props["0"] || props.href;
      if (href !== undefined) {
        anchor.href = String(href);
      }
      if (props.target !== undefined) {
        anchor.target = String(props.target);
      }
      if (props.rel !== undefined) {
        anchor.rel = String(props.rel);
      }
    }
  };
});

// src/dom/components/textarea.ts
var exports_textarea = {};
__export(exports_textarea, {
  textareaHandler: () => textareaHandler
});
var textareaHandler;
var init_textarea = __esm(() => {
  textareaHandler = {
    create() {
      const el = document.createElement("textarea");
      el.dataset.hypenType = "textarea";
      return el;
    },
    applyProps(el, props) {
      const textarea = el;
      const value = props["0"] || props.value;
      if (value !== undefined) {
        textarea.value = String(value);
      }
      if (props.placeholder !== undefined) {
        textarea.placeholder = String(props.placeholder);
      }
      if (props.rows !== undefined) {
        textarea.rows = Number(props.rows);
      }
      if (props.cols !== undefined) {
        textarea.cols = Number(props.cols);
      }
      if (props.disabled !== undefined) {
        textarea.disabled = Boolean(props.disabled);
      }
      if (props.readonly !== undefined) {
        textarea.readOnly = Boolean(props.readonly);
      }
    }
  };
});

// src/dom/components/checkbox.ts
var exports_checkbox = {};
__export(exports_checkbox, {
  checkboxHandler: () => checkboxHandler
});
var checkboxHandler;
var init_checkbox = __esm(() => {
  checkboxHandler = {
    create() {
      const wrapper = document.createElement("label");
      wrapper.dataset.hypenType = "checkbox";
      wrapper.style.display = "inline-flex";
      wrapper.style.alignItems = "center";
      wrapper.style.gap = "8px";
      wrapper.style.cursor = "pointer";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.hypenCheckbox = "true";
      wrapper.appendChild(input);
      return wrapper;
    },
    applyProps(el, props) {
      const input = el.querySelector('input[type="checkbox"]');
      if (!input)
        return;
      if (props.checked !== undefined) {
        input.checked = Boolean(props.checked);
      }
      if (props.disabled !== undefined) {
        input.disabled = Boolean(props.disabled);
      }
      const label = props["0"] || props.label;
      if (label !== undefined) {
        const textNodes = Array.from(el.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE);
        textNodes.forEach((node) => node.remove());
        el.appendChild(document.createTextNode(String(label)));
      }
    }
  };
});

// src/dom/components/select.ts
var exports_select = {};
__export(exports_select, {
  selectHandler: () => selectHandler
});
var selectHandler;
var init_select = __esm(() => {
  selectHandler = {
    create() {
      const el = document.createElement("select");
      el.dataset.hypenType = "select";
      return el;
    },
    applyProps(el, props) {
      const select = el;
      if (props.value !== undefined) {
        select.value = String(props.value);
      }
      if (props.disabled !== undefined) {
        select.disabled = Boolean(props.disabled);
      }
      if (props.multiple !== undefined) {
        select.multiple = Boolean(props.multiple);
      }
      if (props.options && Array.isArray(props.options)) {
        select.innerHTML = "";
        props.options.forEach((opt) => {
          const option = document.createElement("option");
          if (typeof opt === "string") {
            option.value = opt;
            option.textContent = opt;
          } else if (typeof opt === "object") {
            option.value = String(opt.value ?? opt.label ?? "");
            option.textContent = String(opt.label ?? opt.value ?? "");
            if (opt.disabled)
              option.disabled = true;
          }
          select.appendChild(option);
        });
      }
    }
  };
});

// src/dom/components/spacer.ts
var exports_spacer = {};
__export(exports_spacer, {
  spacerHandler: () => spacerHandler
});
var spacerHandler;
var init_spacer = __esm(() => {
  spacerHandler = {
    create() {
      const el = document.createElement("div");
      el.style.flex = "1";
      el.dataset.hypenType = "spacer";
      return el;
    }
  };
});

// src/dom/components/stack.ts
var exports_stack = {};
__export(exports_stack, {
  stackHandler: () => stackHandler
});
var stackHandler;
var init_stack = __esm(() => {
  stackHandler = {
    create() {
      const el = document.createElement("div");
      el.style.position = "relative";
      el.style.display = "flex";
      el.dataset.hypenType = "stack";
      const style = document.createElement("style");
      style.textContent = `
      [data-hypen-type="stack"] > * {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
      }
      [data-hypen-type="stack"] > *:first-child {
        position: relative;
      }
    `;
      el.appendChild(style);
      return el;
    }
  };
});

// src/dom/components/divider.ts
var exports_divider = {};
__export(exports_divider, {
  dividerHandler: () => dividerHandler
});
var dividerHandler;
var init_divider = __esm(() => {
  dividerHandler = {
    create() {
      const el = document.createElement("hr");
      el.dataset.hypenType = "divider";
      el.style.border = "none";
      el.style.borderTop = "1px solid #e0e0e0";
      el.style.margin = "0";
      return el;
    },
    applyProps(el, props) {
      if (props.thickness !== undefined) {
        const thickness = typeof props.thickness === "number" ? `${props.thickness}px` : String(props.thickness);
        el.style.borderTopWidth = thickness;
      }
      if (props.orientation === "vertical") {
        el.style.borderTop = "none";
        el.style.borderLeft = "1px solid #e0e0e0";
        el.style.height = "100%";
        el.style.width = "0";
        el.style.display = "inline-block";
      }
    }
  };
});

// src/dom/components/grid.ts
var exports_grid = {};
__export(exports_grid, {
  gridHandler: () => gridHandler
});
var gridHandler;
var init_grid = __esm(() => {
  gridHandler = {
    create() {
      const el = document.createElement("div");
      el.style.display = "grid";
      el.dataset.hypenType = "grid";
      return el;
    },
    applyProps(el, props) {
      if (props.columns !== undefined) {
        const n = Number(props.columns);
        if (Number.isInteger(n) && n >= 1) el.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
      }
      if (props.gap !== undefined) {
        const gap = typeof props.gap === "number" ? `${props.gap}px` : String(props.gap);
        el.style.gap = gap;
      }
    }
  };
});

// src/dom/components/card.ts
var exports_card = {};
__export(exports_card, {
  cardHandler: () => cardHandler
});
var cardHandler;
var init_card = __esm(() => {
  cardHandler = {
    create() {
      const el = document.createElement("div");
      el.dataset.hypenType = "card";
      el.style.backgroundColor = "#ffffff";
      el.style.borderRadius = "8px";
      el.style.boxShadow = "0 2px 4px rgba(0, 0, 0, 0.1)";
      el.style.padding = "16px";
      return el;
    }
  };
});

// src/dom/components/heading.ts
var exports_heading = {};
__export(exports_heading, {
  headingHandler: () => headingHandler
});
var headingHandler;
var init_heading = __esm(() => {
  headingHandler = {
    create() {
      const el = document.createElement("h2");
      el.dataset.hypenType = "heading";
      return el;
    },
    applyProps(el, props) {
      if (props.level !== undefined) {
        const level = Math.max(1, Math.min(6, Number(props.level)));
        const newEl = document.createElement(`h${level}`);
        newEl.dataset.hypenType = "heading";
        newEl.innerHTML = el.innerHTML;
        Array.from(el.attributes).forEach((attr) => {
          newEl.setAttribute(attr.name, attr.value);
        });
        if (el.parentNode) {
          el.parentNode.replaceChild(newEl, el);
        }
      }
      const text = props["0"] || props.text;
      if (text !== undefined) {
        el.textContent = String(text);
      }
    }
  };
});

// src/dom/components/switch.ts
var exports_switch = {};
__export(exports_switch, {
  switchHandler: () => switchHandler
});
var switchHandler;
var init_switch = __esm(() => {
  switchHandler = {
    create() {
      const wrapper = document.createElement("label");
      wrapper.dataset.hypenType = "switch";
      wrapper.style.display = "inline-flex";
      wrapper.style.alignItems = "center";
      wrapper.style.gap = "8px";
      wrapper.style.cursor = "pointer";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.hypenSwitch = "true";
      input.style.appearance = "none";
      input.style.width = "44px";
      input.style.height = "24px";
      input.style.backgroundColor = "#ccc";
      input.style.borderRadius = "12px";
      input.style.position = "relative";
      input.style.cursor = "pointer";
      input.style.transition = "background-color 0.2s";
      const style = document.createElement("style");
      style.textContent = `
      input[data-hypen-switch="true"]::before {
        content: "";
        position: absolute;
        width: 20px;
        height: 20px;
        background-color: white;
        border-radius: 50%;
        top: 2px;
        left: 2px;
        transition: transform 0.2s;
      }
      input[data-hypen-switch="true"]:checked {
        background-color: #4CAF50;
      }
      input[data-hypen-switch="true"]:checked::before {
        transform: translateX(20px);
      }
    `;
      wrapper.appendChild(style);
      wrapper.appendChild(input);
      return wrapper;
    },
    applyProps(el, props) {
      const input = el.querySelector('input[type="checkbox"]');
      if (!input)
        return;
      if (props.on !== undefined) {
        input.checked = Boolean(props.on);
      }
      if (props.disabled !== undefined) {
        input.disabled = Boolean(props.disabled);
      }
      const label = props["0"] || props.label;
      if (label !== undefined) {
        const textNodes = Array.from(el.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE);
        textNodes.forEach((node) => node.remove());
        el.appendChild(document.createTextNode(String(label)));
      }
    }
  };
});

// src/dom/components/slider.ts
var exports_slider = {};
__export(exports_slider, {
  sliderHandler: () => sliderHandler
});
var sliderHandler;
var init_slider = __esm(() => {
  sliderHandler = {
    create() {
      const el = document.createElement("input");
      el.type = "range";
      el.dataset.hypenType = "slider";
      return el;
    },
    applyProps(el, props) {
      const input = el;
      if (props.value !== undefined) {
        input.value = String(props.value);
      }
      if (props.min !== undefined) {
        input.min = String(props.min);
      }
      if (props.max !== undefined) {
        input.max = String(props.max);
      }
      if (props.step !== undefined) {
        input.step = String(props.step);
      }
      if (props.disabled !== undefined) {
        input.disabled = Boolean(props.disabled);
      }
    }
  };
});

// src/dom/components/spinner.ts
var exports_spinner = {};
__export(exports_spinner, {
  spinnerHandler: () => spinnerHandler
});
var spinnerHandler;
var init_spinner = __esm(() => {
  spinnerHandler = {
    create() {
      const wrapper = document.createElement("div");
      wrapper.dataset.hypenType = "spinner";
      wrapper.style.display = "inline-block";
      const spinner = document.createElement("div");
      spinner.style.width = "40px";
      spinner.style.height = "40px";
      spinner.style.border = "4px solid #f3f3f3";
      spinner.style.borderTop = "4px solid #3498db";
      spinner.style.borderRadius = "50%";
      spinner.style.animation = "spin 1s linear infinite";
      const style = document.createElement("style");
      style.textContent = `
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    `;
      wrapper.appendChild(style);
      wrapper.appendChild(spinner);
      return wrapper;
    },
    applyProps(el, props) {
      const spinner = el.querySelector("div:not(style)");
      if (!spinner)
        return;
      if (props.size !== undefined) {
        const size = String(props.size);
        const sizeMap = {
          small: "24px",
          medium: "40px",
          large: "60px"
        };
        const actualSize = sizeMap[size] || size;
        spinner.style.width = actualSize;
        spinner.style.height = actualSize;
      }
      if (props.color !== undefined) {
        spinner.style.borderTopColor = String(props.color);
      }
    }
  };
});

// src/dom/components/badge.ts
var exports_badge = {};
__export(exports_badge, {
  badgeHandler: () => badgeHandler
});
var badgeHandler;
var init_badge = __esm(() => {
  badgeHandler = {
    create() {
      const el = document.createElement("span");
      el.dataset.hypenType = "badge";
      el.style.display = "inline-block";
      el.style.padding = "4px 8px";
      el.style.borderRadius = "4px";
      el.style.fontSize = "12px";
      el.style.fontWeight = "600";
      el.style.backgroundColor = "#e0e0e0";
      el.style.color = "#333";
      return el;
    },
    applyProps(el, props) {
      if (props.theme !== undefined) {
        const theme = String(props.theme);
        const themeColors = {
          success: { bg: "#4CAF50", color: "#fff" },
          error: { bg: "#f44336", color: "#fff" },
          warning: { bg: "#ff9800", color: "#fff" },
          info: { bg: "#2196F3", color: "#fff" },
          default: { bg: "#e0e0e0", color: "#333" }
        };
        const colors = themeColors[theme] || themeColors.default;
        el.style.backgroundColor = colors.bg;
        el.style.color = colors.color;
      }
      const text = props["0"] || props.text;
      if (text !== undefined) {
        el.textContent = String(text);
      }
    }
  };
});

// src/dom/components/avatar.ts
var exports_avatar = {};
__export(exports_avatar, {
  avatarHandler: () => avatarHandler
});
var avatarHandler;
var init_avatar = __esm(() => {
  avatarHandler = {
    create() {
      const el = document.createElement("div");
      el.dataset.hypenType = "avatar";
      el.style.display = "inline-flex";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.width = "40px";
      el.style.height = "40px";
      el.style.borderRadius = "50%";
      el.style.backgroundColor = "#9e9e9e";
      el.style.color = "#fff";
      el.style.fontSize = "16px";
      el.style.fontWeight = "600";
      el.style.overflow = "hidden";
      return el;
    },
    applyProps(el, props) {
      if (props.src !== undefined) {
        const img = document.createElement("img");
        img.src = String(props.src);
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = "cover";
        el.innerHTML = "";
        el.appendChild(img);
      } else if (props.initials !== undefined) {
        el.textContent = String(props.initials).toUpperCase();
      }
      if (props.size !== undefined) {
        const size = typeof props.size === "number" ? `${props.size}px` : String(props.size);
        el.style.width = size;
        el.style.height = size;
      }
    }
  };
});

// src/dom/components/progressbar.ts
var exports_progressbar = {};
__export(exports_progressbar, {
  progressBarHandler: () => progressBarHandler
});
var progressBarHandler;
var init_progressbar = __esm(() => {
  progressBarHandler = {
    create() {
      const wrapper = document.createElement("div");
      wrapper.dataset.hypenType = "progressbar";
      wrapper.style.width = "100%";
      wrapper.style.height = "8px";
      wrapper.style.backgroundColor = "#e0e0e0";
      wrapper.style.borderRadius = "4px";
      wrapper.style.overflow = "hidden";
      const bar = document.createElement("div");
      bar.dataset.hypenBar = "true";
      bar.style.height = "100%";
      bar.style.backgroundColor = "#2196F3";
      bar.style.transition = "width 0.3s ease";
      bar.style.width = "0%";
      wrapper.appendChild(bar);
      return wrapper;
    },
    applyProps(el, props) {
      const bar = el.querySelector('[data-hypen-bar="true"]');
      if (!bar)
        return;
      const value = Number(props.value || 0);
      const max = Number(props.max || 100);
      const percentage = Math.min(100, Math.max(0, value / max * 100));
      bar.style.width = `${percentage}%`;
      if (props.color !== undefined) {
        bar.style.backgroundColor = String(props.color);
      }
      if (props.height !== undefined) {
        const height = typeof props.height === "number" ? `${props.height}px` : String(props.height);
        el.style.height = height;
      }
    }
  };
});

// src/dom/components/video.ts
var exports_video = {};
__export(exports_video, {
  videoHandler: () => videoHandler
});
var videoHandler;
var init_video = __esm(() => {
  videoHandler = {
    create() {
      const el = document.createElement("video");
      el.dataset.hypenType = "video";
      return el;
    },
    applyProps(el, props) {
      const video = el;
      const src = props["0"] || props.src;
      if (src !== undefined) {
        video.src = String(src);
      }
      if (props.controls !== undefined) {
        video.controls = Boolean(props.controls);
      }
      if (props.autoplay !== undefined) {
        video.autoplay = Boolean(props.autoplay);
      }
      if (props.loop !== undefined) {
        video.loop = Boolean(props.loop);
      }
      if (props.muted !== undefined) {
        video.muted = Boolean(props.muted);
      }
      if (props.poster !== undefined) {
        video.poster = String(props.poster);
      }
    }
  };
});

// src/dom/components/audio.ts
var exports_audio = {};
__export(exports_audio, {
  audioHandler: () => audioHandler
});
var audioHandler;
var init_audio = __esm(() => {
  audioHandler = {
    create() {
      const el = document.createElement("audio");
      el.dataset.hypenType = "audio";
      return el;
    },
    applyProps(el, props) {
      const audio = el;
      const src = props["0"] || props.src;
      if (src !== undefined) {
        audio.src = String(src);
      }
      if (props.controls !== undefined) {
        audio.controls = Boolean(props.controls);
      }
      if (props.autoplay !== undefined) {
        audio.autoplay = Boolean(props.autoplay);
      }
      if (props.loop !== undefined) {
        audio.loop = Boolean(props.loop);
      }
      if (props.muted !== undefined) {
        audio.muted = Boolean(props.muted);
      }
    }
  };
});

// src/dom/components/paragraph.ts
var exports_paragraph = {};
__export(exports_paragraph, {
  paragraphHandler: () => paragraphHandler
});
var paragraphHandler;
var init_paragraph = __esm(() => {
  paragraphHandler = {
    create() {
      const el = document.createElement("p");
      el.dataset.hypenType = "paragraph";
      return el;
    },
    applyProps(el, props) {
      const text = props["0"] || props.text;
      if (text !== undefined) {
        el.textContent = String(text);
      }
    }
  };
});

// src/dom/components/router.ts
var exports_router = {};
__export(exports_router, {
  routerHandler: () => routerHandler
});
var routerHandler;
var init_router = __esm(() => {
  routerHandler = {
    create() {
      const el = document.createElement("div");
      el.style.display = "flex";
      el.style.flexDirection = "column";
      el.style.width = "100%";
      el.dataset.hypenType = "router";
      return el;
    },
    applyProps(el, props) {}
  };
});

// src/dom/components/route.ts
var exports_route = {};
__export(exports_route, {
  routeHandler: () => routeHandler
});
var routeHandler;
var init_route = __esm(() => {
  routeHandler = {
    create() {
      const el = document.createElement("div");
      el.style.display = "flex";
      el.style.flexDirection = "column";
      el.style.width = "100%";
      el.dataset.hypenType = "route";
      el.dataset.routeRendered = "false";
      return el;
    },
    applyProps(el, props) {
      const path = props.path || props["0"] || "/";
      el.dataset.routePath = String(path);
      const isLazy = props.__lazy === true;
      el.dataset.routeLazy = String(isLazy);
      const componentName = props.component || props.__lazy_child;
      if (componentName) {
        el.dataset.routeComponent = String(componentName);
      }
      console.log(`\uD83D\uDEE3️ Route created: path="${path}", lazy=${isLazy}, component="${el.dataset.routeComponent || "none"}"`);
    }
  };
});

// src/dom/applicators/padding.ts
var exports_padding = {};
__export(exports_padding, {
  paddingHandler: () => paddingHandler
});
var paddingHandler = (el, value) => {
  if (typeof value === "number") {
    el.style.padding = `${value}px`;
  } else if (typeof value === "object") {
    if (value.left !== undefined)
      el.style.paddingLeft = `${value.left}px`;
    if (value.right !== undefined)
      el.style.paddingRight = `${value.right}px`;
    if (value.top !== undefined)
      el.style.paddingTop = `${value.top}px`;
    if (value.bottom !== undefined)
      el.style.paddingBottom = `${value.bottom}px`;
  } else {
    el.style.padding = String(value);
  }
};

// src/dom/applicators/margin.ts
var exports_margin = {};
__export(exports_margin, {
  marginHandler: () => marginHandler
});
var marginHandler = (el, value) => {
  if (typeof value === "number") {
    el.style.margin = `${value}px`;
  } else if (typeof value === "object") {
    if (value.left !== undefined)
      el.style.marginLeft = `${value.left}px`;
    if (value.right !== undefined)
      el.style.marginRight = `${value.right}px`;
    if (value.top !== undefined)
      el.style.marginTop = `${value.top}px`;
    if (value.bottom !== undefined)
      el.style.marginBottom = `${value.bottom}px`;
  } else {
    el.style.margin = String(value);
  }
};

// src/dom/applicators/color.ts
var exports_color = {};
__export(exports_color, {
  colorHandlers: () => colorHandlers
});
var colorHandlers;
var init_color = __esm(() => {
  colorHandlers = {
    color: (el, value) => {
      el.style.color = String(value);
    },
    backgroundColor: (el, value) => {
      el.style.backgroundColor = String(value);
    },
    borderColor: (el, value) => {
      el.style.borderColor = String(value);
    },
    opacity: (el, value) => {
      el.style.opacity = String(value);
    }
  };
});

// src/dom/applicators/border.ts
var exports_border = {};
__export(exports_border, {
  borderHandlers: () => borderHandlers
});
var borderHandlers;
var init_border = __esm(() => {
  borderHandlers = {
    borderWidth: (el, value) => {
      el.style.borderWidth = typeof value === "number" ? `${value}px` : String(value);
    },
    borderStyle: (el, value) => {
      el.style.borderStyle = String(value);
    },
    borderRadius: (el, value) => {
      el.style.borderRadius = typeof value === "number" ? `${value}px` : String(value);
    }
  };
});

// src/dom/applicators/size.ts
var exports_size = {};
__export(exports_size, {
  sizeHandlers: () => sizeHandlers
});
var sizeHandlers;
var init_size = __esm(() => {
  sizeHandlers = {
    width: (el, value) => {
      el.style.width = typeof value === "number" ? `${value}px` : String(value);
    },
    height: (el, value) => {
      el.style.height = typeof value === "number" ? `${value}px` : String(value);
    },
    minWidth: (el, value) => {
      el.style.minWidth = typeof value === "number" ? `${value}px` : String(value);
    },
    minHeight: (el, value) => {
      el.style.minHeight = typeof value === "number" ? `${value}px` : String(value);
    },
    maxWidth: (el, value) => {
      el.style.maxWidth = typeof value === "number" ? `${value}px` : String(value);
    },
    maxHeight: (el, value) => {
      el.style.maxHeight = typeof value === "number" ? `${value}px` : String(value);
    }
  };
});

// src/dom/applicators/font.ts
var exports_font = {};
__export(exports_font, {
  fontHandlers: () => fontHandlers
});
var fontHandlers;
var init_font = __esm(() => {
  fontHandlers = {
    fontSize: (el, value) => {
      el.style.fontSize = typeof value === "number" ? `${value}px` : String(value);
    },
    fontWeight: (el, value) => {
      el.style.fontWeight = String(value);
    },
    fontFamily: (el, value) => {
      el.style.fontFamily = String(value);
    },
    textAlign: (el, value) => {
      el.style.textAlign = String(value);
    },
    lineHeight: (el, value) => {
      el.style.lineHeight = String(value);
    }
  };
});

// src/dom/applicators/layout.ts
var exports_layout = {};
__export(exports_layout, {
  layoutHandlers: () => layoutHandlers
});
var layoutHandlers;
var init_layout = __esm(() => {
  layoutHandlers = {
    verticalAlignment: (el, value) => {
      const val = String(value);
      const flexDirection = getComputedStyle(el).flexDirection;
      if (flexDirection === "column" || flexDirection === "column-reverse") {
        el.style.justifyContent = val;
      } else {
        el.style.alignItems = val;
      }
    },
    horizontalAlignment: (el, value) => {
      const val = String(value);
      const flexDirection = getComputedStyle(el).flexDirection;
      if (flexDirection === "column" || flexDirection === "column-reverse") {
        el.style.alignItems = val;
      } else {
        el.style.justifyContent = val;
      }
    },
    horizontalAlign: (el, value) => {
      el.style.justifyContent = String(value);
    },
    verticalAlign: (el, value) => {
      el.style.alignItems = String(value);
    },
    gap: (el, value) => {
      el.style.gap = typeof value === "number" ? `${value}px` : String(value);
    },
    weight: (el, value) => {
      el.style.flex = String(value);
    },
    flex: (el, value) => {
      el.style.flex = String(value);
    },
    flexGrow: (el, value) => {
      el.style.flexGrow = String(value);
    },
    flexShrink: (el, value) => {
      el.style.flexShrink = String(value);
    },
    cursor: (el, value) => {
      el.style.cursor = String(value);
    },
    overflow: (el, value) => {
      el.style.overflow = String(value);
    },
    scrollable: (el, value) => {
      if (value === true || value === "true") {
        el.style.overflow = "auto";
      } else if (value === false || value === "false") {
        el.style.overflow = "hidden";
      } else if (value === "vertical") {
        el.style.overflowX = "hidden";
        el.style.overflowY = "auto";
      } else if (value === "horizontal") {
        el.style.overflowX = "auto";
        el.style.overflowY = "hidden";
      } else if (value === "both") {
        el.style.overflow = "auto";
      } else {
        el.style.overflow = String(value);
      }
    }
  };
});

// src/dom/applicators/events.ts
var exports_events = {};
__export(exports_events, {
  eventHandlers: () => eventHandlers
});
function toPlainObject(value) {
  if (value instanceof Map) {
    const obj = {};
    for (const [key, val] of value.entries()) {
      obj[key] = toPlainObject(val);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toPlainObject(item));
  }
  if (value && typeof value === "object") {
    const obj = {};
    for (const [key, val] of Object.entries(value)) {
      obj[key] = toPlainObject(val);
    }
    return obj;
  }
  return value;
}
function extractActionDetails(value) {
  if (typeof value === "string") {
    if (!value.startsWith("@")) {
      return { actionName: null, payload: {} };
    }
    let actionName = value.substring(1);
    if (actionName.startsWith("actions.")) {
      actionName = actionName.substring(8);
    }
    return { actionName, payload: {} };
  }
  if (value && typeof value === "object") {
    const plain = toPlainObject(value);
    const payload = {};
    let actionName = null;
    if (plain && typeof plain === "object") {
      const actionValue = plain["0"];
      if (typeof actionValue === "string" && actionValue.startsWith("@")) {
        actionName = actionValue.substring(1);
        if (actionName.startsWith("actions.")) {
          actionName = actionName.substring(8);
        }
      }
      for (const [key, val] of Object.entries(plain)) {
        if (key !== "0") {
          payload[key] = val;
        }
      }
    }
    return { actionName, payload };
  }
  return { actionName: null, payload: {} };
}
function extractEventData(event, element) {
  const data = {
    type: event.type,
    timestamp: Date.now()
  };
  if (event instanceof MouseEvent) {
    data.clientX = event.clientX;
    data.clientY = event.clientY;
    data.button = event.button;
  }
  if (event instanceof KeyboardEvent) {
    data.key = event.key;
    data.code = event.code;
    data.ctrlKey = event.ctrlKey;
    data.shiftKey = event.shiftKey;
    data.altKey = event.altKey;
    data.metaKey = event.metaKey;
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    data.value = element.value;
  }
  if (element instanceof HTMLSelectElement) {
    data.value = element.value;
    data.selectedIndex = element.selectedIndex;
  }
  if (event.type === "submit" && element instanceof HTMLFormElement) {
    data.formData = new FormData(element);
  }
  return data;
}
var eventHandlers;
var init_events = __esm(() => {
  eventHandlers = {
    onClick: (element, value) => {
      console.log(`[EventApplicator] onClick called with value:`, value);
      const { actionName, payload: customPayload } = extractActionDetails(value);
      if (!actionName) {
        console.warn(`[EventApplicator] onClick value must be an action reference, got:`, value);
        return;
      }
      const existingListener = element.__hypenClickListener;
      if (existingListener) {
        element.removeEventListener("click", existingListener);
      }
      const listener = (event) => {
        console.log(`\uD83D\uDD25 [EventApplicator] onClick fired, dispatching action: ${actionName}`);
        const payload = Object.keys(customPayload).length > 0 ? { ...customPayload } : extractEventData(event, element);
        console.log(`[EventApplicator] onClick payload:`, payload);
        const engine = element.__hypenEngine;
        if (engine) {
          engine.dispatchAction(actionName, payload);
        } else {
          console.warn(`[EventApplicator] No engine attached to element for onClick`);
        }
      };
      element.__hypenClickListener = listener;
      element.addEventListener("click", listener);
      console.log(`[EventApplicator] onClick handler attached for action: ${actionName}`);
    },
    onPress: (element, value) => {
      eventHandlers.onClick(element, value);
    },
    onChange: (element, value) => {
      const { actionName } = extractActionDetails(value);
      if (!actionName) {
        console.warn(`[EventApplicator] onChange value must be an action reference starting with @, got:`, value);
        return;
      }
      const existingListener = element.__hypenChangeListener;
      if (existingListener) {
        element.removeEventListener("change", existingListener);
      }
      const listener = (event) => {
        console.log(`\uD83D\uDD25 [EventApplicator] onChange fired, dispatching action: ${actionName}`);
        const payload = extractEventData(event, element);
        const engine = element.__hypenEngine;
        if (engine) {
          engine.dispatchAction(actionName, payload);
        } else {
          console.warn(`[EventApplicator] No engine attached to element for onChange`);
        }
      };
      element.__hypenChangeListener = listener;
      element.addEventListener("change", listener);
      console.log(`[EventApplicator] onChange handler attached for action: ${actionName}`);
    },
    onSubmit: (element, value) => {
      const { actionName } = extractActionDetails(value);
      if (!actionName) {
        console.warn(`[EventApplicator] onSubmit value must be an action reference starting with @, got:`, value);
        return;
      }
      const existingListener = element.__hypenSubmitListener;
      if (existingListener) {
        element.removeEventListener("submit", existingListener);
      }
      const listener = (event) => {
        console.log(`\uD83D\uDD25 [EventApplicator] onSubmit fired, dispatching action: ${actionName}`);
        event.preventDefault();
        const payload = extractEventData(event, element);
        const engine = element.__hypenEngine;
        if (engine) {
          engine.dispatchAction(actionName, payload);
        } else {
          console.warn(`[EventApplicator] No engine attached to element for onSubmit`);
        }
      };
      element.__hypenSubmitListener = listener;
      element.addEventListener("submit", listener);
      console.log(`[EventApplicator] onSubmit handler attached for action: ${actionName}`);
    },
    onInput: (element, value) => {
      console.log(`[EventApplicator] onInput called with value:`, value);
      const { actionName } = extractActionDetails(value);
      if (!actionName) {
        console.warn(`[EventApplicator] onInput value must be an action reference starting with @, got:`, value);
        return;
      }
      const existingListener = element.__hypenInputListener;
      if (existingListener) {
        element.removeEventListener("input", existingListener);
      }
      const listener = (event) => {
        console.log(`\uD83D\uDD25 [EventApplicator] onInput fired, dispatching action: ${actionName}`);
        const target = event.target;
        const payload = {
          type: event.type,
          timestamp: Date.now(),
          value: target.value,
          input: target.value
        };
        console.log(`[EventApplicator] onInput payload:`, payload);
        const engine = element.__hypenEngine;
        if (engine) {
          engine.dispatchAction(actionName, payload);
        } else {
          console.warn(`[EventApplicator] No engine attached to element for onInput`);
        }
      };
      element.__hypenInputListener = listener;
      element.addEventListener("input", listener);
      console.log(`[EventApplicator] onInput handler attached for action: ${actionName}`);
    },
    onKey: (element, value) => {
      console.log(`[EventApplicator] onKey called with value:`, value);
      const { actionName } = extractActionDetails(value);
      if (actionName) {
        const existingListener = element.__hypenKeyListener;
        if (existingListener) {
          element.removeEventListener("keydown", existingListener);
        }
        const listener = (event) => {
          if (event.key === "Enter") {
            console.log(`\uD83D\uDD25 [EventApplicator] onKey fired (Enter), dispatching action: ${actionName}`);
            event.preventDefault();
            const target = event.target;
            const payload = {
              type: event.type,
              timestamp: Date.now(),
              key: event.key,
              code: event.code,
              value: target.value,
              input: target.value,
              ctrlKey: event.ctrlKey,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
              metaKey: event.metaKey
            };
            const engine = element.__hypenEngine;
            if (engine) {
              engine.dispatchAction(actionName, payload);
            } else {
              console.warn(`[EventApplicator] No engine attached to element for onKey`);
            }
          }
        };
        element.__hypenKeyListener = listener;
        element.addEventListener("keydown", listener);
        console.log(`[EventApplicator] onKey handler attached for action: ${actionName} (triggers on Enter)`);
      } else {
        console.warn(`[EventApplicator] onKey value must be an action reference starting with @, got: ${value}`);
      }
    },
    "onKey.key": (element, keyValue) => {
      console.log(`[EventApplicator] onKey.key called with value:`, keyValue);
      element.__hypenKeyTarget = keyValue;
    },
    "onKey.action": (element, value) => {
      console.log(`[EventApplicator] onKey.action called with value:`, value);
      const { actionName } = extractActionDetails(value);
      if (actionName) {
        const targetKey = element.__hypenKeyTarget || "Enter";
        const existingListener = element.__hypenKeyListener;
        if (existingListener) {
          element.removeEventListener("keydown", existingListener);
        }
        const listener = (event) => {
          const keyToMatch = targetKey.toLowerCase() === "return" ? "Enter" : targetKey;
          if (event.key === keyToMatch) {
            console.log(`\uD83D\uDD25 [EventApplicator] onKey fired (${keyToMatch}), dispatching action: ${actionName}`);
            event.preventDefault();
            const target = event.target;
            const payload = {
              type: event.type,
              timestamp: Date.now(),
              key: event.key,
              code: event.code,
              value: target.value,
              input: target.value,
              ctrlKey: event.ctrlKey,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
              metaKey: event.metaKey
            };
            const engine = element.__hypenEngine;
            if (engine) {
              engine.dispatchAction(actionName, payload);
            }
          }
        };
        element.__hypenKeyListener = listener;
        element.addEventListener("keydown", listener);
        console.log(`[EventApplicator] onKey handler attached for action: ${actionName} on key: ${targetKey}`);
      }
    },
    onScroll: (element, value) => {
      console.log(`[EventApplicator] onScroll called with value:`, value);
      const { actionName } = extractActionDetails(value);
      if (actionName) {
        const existingListener = element.__hypenScrollListener;
        if (existingListener) {
          element.removeEventListener("scroll", existingListener);
        }
        let throttleTimer = null;
        const listener = (event) => {
          if (throttleTimer)
            return;
          throttleTimer = setTimeout(() => {
            throttleTimer = null;
          }, 100);
          const target = event.target;
          const scrollTop = target.scrollTop;
          const scrollHeight = target.scrollHeight;
          const clientHeight = target.clientHeight;
          const scrollPercentage = scrollTop / (scrollHeight - clientHeight) * 100;
          const nearBottom = scrollHeight - scrollTop - clientHeight < 100 || scrollPercentage > 90;
          console.log(`\uD83D\uDD25 [EventApplicator] onScroll fired, scrollTop: ${scrollTop}, nearBottom: ${nearBottom}`);
          const payload = {
            type: "scroll",
            timestamp: Date.now(),
            scrollTop,
            scrollLeft: target.scrollLeft,
            scrollHeight,
            scrollWidth: target.scrollWidth,
            clientHeight,
            clientWidth: target.clientWidth,
            scrollPercentage: Math.round(scrollPercentage),
            nearBottom,
            atBottom: scrollHeight - scrollTop === clientHeight,
            atTop: scrollTop === 0
          };
          const engine = element.__hypenEngine;
          if (engine) {
            engine.dispatchAction(actionName, payload);
          } else {
            console.warn(`[EventApplicator] No engine attached to element for onScroll`);
          }
        };
        element.__hypenScrollListener = listener;
        element.addEventListener("scroll", listener, { passive: true });
        console.log(`[EventApplicator] onScroll handler attached for action: ${actionName}`);
      } else {
        console.warn(`[EventApplicator] onScroll value must be an action reference starting with @, got: ${value}`);
      }
    },
    onLongClick: (element, value) => {
      console.log(`[EventApplicator] onLongClick called with value:`, value);
      const { actionName, payload: customPayload } = extractActionDetails(value);
      if (!actionName) {
        console.warn(`[EventApplicator] onLongClick value must be an action reference, got:`, value);
        return;
      }
      const existingDownListener = element.__hypenLongClickDownListener;
      const existingUpListener = element.__hypenLongClickUpListener;
      if (existingDownListener) {
        element.removeEventListener("pointerdown", existingDownListener);
      }
      if (existingUpListener) {
        element.removeEventListener("pointerup", existingUpListener);
        element.removeEventListener("pointerleave", existingUpListener);
      }
      let longClickTimer = null;
      const LONG_CLICK_THRESHOLD = 500;
      const downListener = (event) => {
        longClickTimer = setTimeout(() => {
          console.log(`\uD83D\uDD25 [EventApplicator] onLongClick fired, dispatching action: ${actionName}`);
          const payload = Object.keys(customPayload).length > 0 ? { ...customPayload } : {
            type: "longclick",
            timestamp: Date.now(),
            clientX: event.clientX,
            clientY: event.clientY
          };
          const engine = element.__hypenEngine;
          if (engine) {
            engine.dispatchAction(actionName, payload);
          } else {
            console.warn(`[EventApplicator] No engine attached to element for onLongClick`);
          }
          longClickTimer = null;
        }, LONG_CLICK_THRESHOLD);
      };
      const upListener = () => {
        if (longClickTimer) {
          clearTimeout(longClickTimer);
          longClickTimer = null;
        }
      };
      element.__hypenLongClickDownListener = downListener;
      element.__hypenLongClickUpListener = upListener;
      element.addEventListener("pointerdown", downListener);
      element.addEventListener("pointerup", upListener);
      element.addEventListener("pointerleave", upListener);
      console.log(`[EventApplicator] onLongClick handler attached for action: ${actionName}`);
    },
    onFocus: (element, value) => {
      console.log(`[EventApplicator] onFocus called with value:`, value);
      const { actionName, payload: customPayload } = extractActionDetails(value);
      if (!actionName) {
        console.warn(`[EventApplicator] onFocus value must be an action reference, got:`, value);
        return;
      }
      const existingListener = element.__hypenFocusListener;
      if (existingListener) {
        element.removeEventListener("focus", existingListener);
      }
      const listener = (event) => {
        console.log(`\uD83D\uDD25 [EventApplicator] onFocus fired, dispatching action: ${actionName}`);
        const target = event.target;
        const payload = Object.keys(customPayload).length > 0 ? { ...customPayload } : {
          type: "focus",
          timestamp: Date.now(),
          value: target.value ?? undefined
        };
        const engine = element.__hypenEngine;
        if (engine) {
          engine.dispatchAction(actionName, payload);
        } else {
          console.warn(`[EventApplicator] No engine attached to element for onFocus`);
        }
      };
      element.__hypenFocusListener = listener;
      element.addEventListener("focus", listener);
      console.log(`[EventApplicator] onFocus handler attached for action: ${actionName}`);
    },
    onBlur: (element, value) => {
      console.log(`[EventApplicator] onBlur called with value:`, value);
      const { actionName, payload: customPayload } = extractActionDetails(value);
      if (!actionName) {
        console.warn(`[EventApplicator] onBlur value must be an action reference, got:`, value);
        return;
      }
      const existingListener = element.__hypenBlurListener;
      if (existingListener) {
        element.removeEventListener("blur", existingListener);
      }
      const listener = (event) => {
        console.log(`\uD83D\uDD25 [EventApplicator] onBlur fired, dispatching action: ${actionName}`);
        const target = event.target;
        const payload = Object.keys(customPayload).length > 0 ? { ...customPayload } : {
          type: "blur",
          timestamp: Date.now(),
          value: target.value ?? undefined
        };
        const engine = element.__hypenEngine;
        if (engine) {
          engine.dispatchAction(actionName, payload);
        } else {
          console.warn(`[EventApplicator] No engine attached to element for onBlur`);
        }
      };
      element.__hypenBlurListener = listener;
      element.addEventListener("blur", listener);
      console.log(`[EventApplicator] onBlur handler attached for action: ${actionName}`);
    },
    onMouseEnter: (element, value) => {
      console.log(`[EventApplicator] onMouseEnter called with value:`, value);
      const { actionName, payload: customPayload } = extractActionDetails(value);
      if (!actionName) {
        console.warn(`[EventApplicator] onMouseEnter value must be an action reference, got:`, value);
        return;
      }
      const existingListener = element.__hypenMouseEnterListener;
      if (existingListener) {
        element.removeEventListener("mouseenter", existingListener);
      }
      const listener = (event) => {
        console.log(`\uD83D\uDD25 [EventApplicator] onMouseEnter fired, dispatching action: ${actionName}`);
        const payload = Object.keys(customPayload).length > 0 ? { ...customPayload } : {
          type: "mouseenter",
          timestamp: Date.now(),
          clientX: event.clientX,
          clientY: event.clientY
        };
        const engine = element.__hypenEngine;
        if (engine) {
          engine.dispatchAction(actionName, payload);
        } else {
          console.warn(`[EventApplicator] No engine attached to element for onMouseEnter`);
        }
      };
      element.__hypenMouseEnterListener = listener;
      element.addEventListener("mouseenter", listener);
      console.log(`[EventApplicator] onMouseEnter handler attached for action: ${actionName}`);
    },
    onMouseLeave: (element, value) => {
      console.log(`[EventApplicator] onMouseLeave called with value:`, value);
      const { actionName, payload: customPayload } = extractActionDetails(value);
      if (!actionName) {
        console.warn(`[EventApplicator] onMouseLeave value must be an action reference, got:`, value);
        return;
      }
      const existingListener = element.__hypenMouseLeaveListener;
      if (existingListener) {
        element.removeEventListener("mouseleave", existingListener);
      }
      const listener = (event) => {
        console.log(`\uD83D\uDD25 [EventApplicator] onMouseLeave fired, dispatching action: ${actionName}`);
        const payload = Object.keys(customPayload).length > 0 ? { ...customPayload } : {
          type: "mouseleave",
          timestamp: Date.now(),
          clientX: event.clientX,
          clientY: event.clientY
        };
        const engine = element.__hypenEngine;
        if (engine) {
          engine.dispatchAction(actionName, payload);
        } else {
          console.warn(`[EventApplicator] No engine attached to element for onMouseLeave`);
        }
      };
      element.__hypenMouseLeaveListener = listener;
      element.addEventListener("mouseleave", listener);
      console.log(`[EventApplicator] onMouseLeave handler attached for action: ${actionName}`);
    }
  };
});

// src/dom/applicators/typography.ts
var exports_typography = {};
__export(exports_typography, {
  typographyHandlers: () => typographyHandlers
});
var typographyHandlers;
var init_typography = __esm(() => {
  typographyHandlers = {
    textAlign: (el, value) => {
      el.style.textAlign = String(value);
    },
    textTransform: (el, value) => {
      el.style.textTransform = String(value);
    },
    textDecoration: (el, value) => {
      el.style.textDecoration = String(value);
    },
    textDecorationColor: (el, value) => {
      el.style.textDecorationColor = String(value);
    },
    textDecorationStyle: (el, value) => {
      el.style.textDecorationStyle = String(value);
    },
    textDecorationThickness: (el, value) => {
      el.style.textDecorationThickness = typeof value === "number" ? `${value}px` : String(value);
    },
    letterSpacing: (el, value) => {
      el.style.letterSpacing = typeof value === "number" ? `${value}px` : String(value);
    },
    wordSpacing: (el, value) => {
      el.style.wordSpacing = typeof value === "number" ? `${value}px` : String(value);
    },
    lineHeight: (el, value) => {
      el.style.lineHeight = String(value);
    },
    textIndent: (el, value) => {
      el.style.textIndent = typeof value === "number" ? `${value}px` : String(value);
    },
    textOverflow: (el, value) => {
      el.style.textOverflow = String(value);
    },
    whiteSpace: (el, value) => {
      el.style.whiteSpace = String(value);
    },
    wordBreak: (el, value) => {
      el.style.wordBreak = String(value);
    },
    verticalAlign: (el, value) => {
      el.style.verticalAlign = String(value);
    },
    fontVariant: (el, value) => {
      el.style.fontVariant = String(value);
    },
    fontStretch: (el, value) => {
      el.style.fontStretch = String(value);
    },
    fontStyle: (el, value) => {
      el.style.fontStyle = String(value);
    },
    writingMode: (el, value) => {
      el.style.writingMode = String(value);
    },
    maxLines: (el, value) => {
      const lines = typeof value === "number" ? value : parseInt(String(value), 10);
      if (!isNaN(lines) && lines > 0) {
        el.style.display = "-webkit-box";
        el.style.setProperty("-webkit-line-clamp", String(lines));
        el.style.setProperty("-webkit-box-orient", "vertical");
        el.style.overflow = "hidden";
      }
    }
  };
});

// src/dom/applicators/transform.ts
var exports_transform = {};
__export(exports_transform, {
  transformHandlers: () => transformHandlers
});
var transformHandlers;
var init_transform = __esm(() => {
  transformHandlers = {
    transform: (el, value) => {
      el.style.transform = String(value);
    },
    transformOrigin: (el, value) => {
      el.style.transformOrigin = String(value);
    },
    translateX: (el, value) => {
      const current = el.style.transform || "";
      const val = typeof value === "number" ? `${value}px` : String(value);
      el.style.transform = current ? `${current} translateX(${val})` : `translateX(${val})`;
    },
    translateY: (el, value) => {
      const current = el.style.transform || "";
      const val = typeof value === "number" ? `${value}px` : String(value);
      el.style.transform = current ? `${current} translateY(${val})` : `translateY(${val})`;
    },
    translateZ: (el, value) => {
      const current = el.style.transform || "";
      const val = typeof value === "number" ? `${value}px` : String(value);
      el.style.transform = current ? `${current} translateZ(${val})` : `translateZ(${val})`;
    },
    rotate: (el, value) => {
      const current = el.style.transform || "";
      const val = String(value);
      el.style.transform = current ? `${current} rotate(${val})` : `rotate(${val})`;
    },
    rotateX: (el, value) => {
      const current = el.style.transform || "";
      const val = String(value);
      el.style.transform = current ? `${current} rotateX(${val})` : `rotateX(${val})`;
    },
    rotateY: (el, value) => {
      const current = el.style.transform || "";
      const val = String(value);
      el.style.transform = current ? `${current} rotateY(${val})` : `rotateY(${val})`;
    },
    rotateZ: (el, value) => {
      const current = el.style.transform || "";
      const val = String(value);
      el.style.transform = current ? `${current} rotateZ(${val})` : `rotateZ(${val})`;
    },
    scale: (el, value) => {
      const current = el.style.transform || "";
      el.style.transform = current ? `${current} scale(${value})` : `scale(${value})`;
    },
    scaleX: (el, value) => {
      const current = el.style.transform || "";
      el.style.transform = current ? `${current} scaleX(${value})` : `scaleX(${value})`;
    },
    scaleY: (el, value) => {
      const current = el.style.transform || "";
      el.style.transform = current ? `${current} scaleY(${value})` : `scaleY(${value})`;
    },
    skew: (el, value) => {
      const current = el.style.transform || "";
      el.style.transform = current ? `${current} skew(${value})` : `skew(${value})`;
    },
    skewX: (el, value) => {
      const current = el.style.transform || "";
      el.style.transform = current ? `${current} skewX(${value})` : `skewX(${value})`;
    },
    skewY: (el, value) => {
      const current = el.style.transform || "";
      el.style.transform = current ? `${current} skewY(${value})` : `skewY(${value})`;
    },
    perspective: (el, value) => {
      el.style.perspective = typeof value === "number" ? `${value}px` : String(value);
    }
  };
});

// src/dom/applicators/effects.ts
var exports_effects = {};
__export(exports_effects, {
  effectsHandlers: () => effectsHandlers
});
var effectsHandlers;
var init_effects = __esm(() => {
  effectsHandlers = {
    boxShadow: (el, value) => {
      el.style.boxShadow = String(value);
    },
    textShadow: (el, value) => {
      el.style.textShadow = String(value);
    },
    filter: (el, value) => {
      el.style.filter = String(value);
    },
    backdropFilter: (el, value) => {
      el.style.backdropFilter = String(value);
    },
    blur: (el, value) => {
      const val = typeof value === "number" ? `${value}px` : String(value);
      const current = el.style.filter || "";
      el.style.filter = current ? `${current} blur(${val})` : `blur(${val})`;
    },
    brightness: (el, value) => {
      const current = el.style.filter || "";
      el.style.filter = current ? `${current} brightness(${value})` : `brightness(${value})`;
    },
    contrast: (el, value) => {
      const current = el.style.filter || "";
      el.style.filter = current ? `${current} contrast(${value})` : `contrast(${value})`;
    },
    grayscale: (el, value) => {
      const current = el.style.filter || "";
      el.style.filter = current ? `${current} grayscale(${value})` : `grayscale(${value})`;
    },
    hueRotate: (el, value) => {
      const val = String(value);
      const current = el.style.filter || "";
      el.style.filter = current ? `${current} hue-rotate(${val})` : `hue-rotate(${val})`;
    },
    invert: (el, value) => {
      const current = el.style.filter || "";
      el.style.filter = current ? `${current} invert(${value})` : `invert(${value})`;
    },
    saturate: (el, value) => {
      const current = el.style.filter || "";
      el.style.filter = current ? `${current} saturate(${value})` : `saturate(${value})`;
    },
    sepia: (el, value) => {
      const current = el.style.filter || "";
      el.style.filter = current ? `${current} sepia(${value})` : `sepia(${value})`;
    },
    dropShadow: (el, value) => {
      const current = el.style.filter || "";
      el.style.filter = current ? `${current} drop-shadow(${value})` : `drop-shadow(${value})`;
    },
    mixBlendMode: (el, value) => {
      el.style.mixBlendMode = String(value);
    },
    backgroundBlendMode: (el, value) => {
      el.style.backgroundBlendMode = String(value);
    },
    clipPath: (el, value) => {
      el.style.clipPath = String(value);
    },
    mask: (el, value) => {
      el.style.mask = String(value);
    },
    maskImage: (el, value) => {
      el.style.maskImage = String(value);
    }
  };
});

// src/dom/applicators/advanced-layout.ts
var exports_advanced_layout = {};
__export(exports_advanced_layout, {
  advancedLayoutHandlers: () => advancedLayoutHandlers
});
var advancedLayoutHandlers;
var init_advanced_layout = __esm(() => {
  advancedLayoutHandlers = {
    flexDirection: (el, value) => {
      el.style.flexDirection = String(value);
    },
    flexBasis: (el, value) => {
      el.style.flexBasis = typeof value === "number" ? `${value}px` : String(value);
    },
    justifyContent: (el, value) => {
      el.style.justifyContent = String(value);
    },
    alignItems: (el, value) => {
      el.style.alignItems = String(value);
    },
    alignContent: (el, value) => {
      el.style.alignContent = String(value);
    },
    alignSelf: (el, value) => {
      el.style.alignSelf = String(value);
    },
    order: (el, value) => {
      el.style.order = String(value);
    },
    gridColumn: (el, value) => {
      const n = Number(String(value).trim().replace(/^span\s+/i, ""));
      if (Number.isInteger(n) && n >= 1) el.style.gridColumn = `span ${n}`;
    },
    rowGap: (el, value) => {
      el.style.rowGap = typeof value === "number" ? `${value}px` : String(value);
    },
    columnGap: (el, value) => {
      el.style.columnGap = typeof value === "number" ? `${value}px` : String(value);
    },
    placeItems: (el, value) => {
      el.style.placeItems = String(value);
    },
    placeContent: (el, value) => {
      el.style.placeContent = String(value);
    },
    placeSelf: (el, value) => {
      el.style.placeSelf = String(value);
    },
    position: (el, value) => {
      el.style.position = String(value);
    },
    top: (el, value) => {
      el.style.top = typeof value === "number" ? `${value}px` : String(value);
    },
    right: (el, value) => {
      el.style.right = typeof value === "number" ? `${value}px` : String(value);
    },
    bottom: (el, value) => {
      el.style.bottom = typeof value === "number" ? `${value}px` : String(value);
    },
    left: (el, value) => {
      el.style.left = typeof value === "number" ? `${value}px` : String(value);
    },
    inset: (el, value) => {
      el.style.inset = typeof value === "number" ? `${value}px` : String(value);
    },
    zIndex: (el, value) => {
      el.style.zIndex = String(value);
    }
  };
});

// src/dom/applicators/background.ts
var exports_background = {};
__export(exports_background, {
  backgroundHandlers: () => backgroundHandlers
});
var backgroundHandlers;
var init_background = __esm(() => {
  backgroundHandlers = {
    backgroundImage: (el, value) => {
      el.style.backgroundImage = String(value);
    },
    backgroundSize: (el, value) => {
      el.style.backgroundSize = String(value);
    },
    backgroundPosition: (el, value) => {
      el.style.backgroundPosition = String(value);
    },
    backgroundRepeat: (el, value) => {
      el.style.backgroundRepeat = String(value);
    },
    backgroundAttachment: (el, value) => {
      el.style.backgroundAttachment = String(value);
    },
    backgroundClip: (el, value) => {
      el.style.backgroundClip = String(value);
    },
    backgroundOrigin: (el, value) => {
      el.style.backgroundOrigin = String(value);
    },
    linearGradient: (el, value) => {
      el.style.backgroundImage = `linear-gradient(${value})`;
    },
    radialGradient: (el, value) => {
      el.style.backgroundImage = `radial-gradient(${value})`;
    },
    conicGradient: (el, value) => {
      el.style.backgroundImage = `conic-gradient(${value})`;
    }
  };
});

// src/dom/applicators/display.ts
var exports_display = {};
__export(exports_display, {
  displayHandlers: () => displayHandlers
});
var displayHandlers;
var init_display = __esm(() => {
  displayHandlers = {
    display: (el, value) => {
      el.style.display = String(value);
    },
    visibility: (el, value) => {
      el.style.visibility = String(value);
    },
    overflowX: (el, value) => {
      el.style.overflowX = String(value);
    },
    overflowY: (el, value) => {
      el.style.overflowY = String(value);
    },
    pointerEvents: (el, value) => {
      el.style.pointerEvents = String(value);
    },
    userSelect: (el, value) => {
      el.style.userSelect = String(value);
    },
    resize: (el, value) => {
      el.style.resize = String(value);
    },
    boxSizing: (el, value) => {
      el.style.boxSizing = String(value);
    },
    aspectRatio: (el, value) => {
      el.style.aspectRatio = String(value);
    },
    objectFit: (el, value) => {
      el.style.objectFit = String(value);
    },
    objectPosition: (el, value) => {
      el.style.objectPosition = String(value);
    }
  };
});

// src/dom/applicators/transition.ts
var exports_transition = {};
__export(exports_transition, {
  transitionHandlers: () => transitionHandlers
});
var transitionHandlers;
var init_transition = __esm(() => {
  transitionHandlers = {
    transition: (el, value) => {
      el.style.transition = String(value);
    },
    transitionProperty: (el, value) => {
      el.style.transitionProperty = String(value);
    },
    transitionDuration: (el, value) => {
      el.style.transitionDuration = String(value);
    },
    transitionTimingFunction: (el, value) => {
      el.style.transitionTimingFunction = String(value);
    },
    transitionDelay: (el, value) => {
      el.style.transitionDelay = String(value);
    },
    animation: (el, value) => {
      el.style.animation = String(value);
    },
    animationName: (el, value) => {
      el.style.animationName = String(value);
    },
    animationDuration: (el, value) => {
      el.style.animationDuration = String(value);
    },
    animationTimingFunction: (el, value) => {
      el.style.animationTimingFunction = String(value);
    },
    animationDelay: (el, value) => {
      el.style.animationDelay = String(value);
    },
    animationIterationCount: (el, value) => {
      el.style.animationIterationCount = String(value);
    },
    animationDirection: (el, value) => {
      el.style.animationDirection = String(value);
    },
    animationFillMode: (el, value) => {
      el.style.animationFillMode = String(value);
    },
    animationPlayState: (el, value) => {
      el.style.animationPlayState = String(value);
    }
  };
});

// ../hypen-engine-rs/pkg/browser/hypen_engine.js
var wasm;
function addToExternrefTable0(obj) {
  const idx = wasm.__externref_table_alloc();
  wasm.__wbindgen_externrefs.set(idx, obj);
  return idx;
}
function debugString(val) {
  const type = typeof val;
  if (type == "number" || type == "boolean" || val == null) {
    return `${val}`;
  }
  if (type == "string") {
    return `"${val}"`;
  }
  if (type == "symbol") {
    const description = val.description;
    if (description == null) {
      return "Symbol";
    } else {
      return `Symbol(${description})`;
    }
  }
  if (type == "function") {
    const name = val.name;
    if (typeof name == "string" && name.length > 0) {
      return `Function(${name})`;
    } else {
      return "Function";
    }
  }
  if (Array.isArray(val)) {
    const length = val.length;
    let debug = "[";
    if (length > 0) {
      debug += debugString(val[0]);
    }
    for (let i = 1;i < length; i++) {
      debug += ", " + debugString(val[i]);
    }
    debug += "]";
    return debug;
  }
  const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
  let className;
  if (builtInMatches && builtInMatches.length > 1) {
    className = builtInMatches[1];
  } else {
    return toString.call(val);
  }
  if (className == "Object") {
    try {
      return "Object(" + JSON.stringify(val) + ")";
    } catch (_) {
      return "Object";
    }
  }
  if (val instanceof Error) {
    return `${val.name}: ${val.message}
${val.stack}`;
  }
  return className;
}
function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
var cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}
function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return decodeText(ptr, len);
}
var cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
function handleError(f, args) {
  try {
    return f.apply(this, args);
  } catch (e) {
    const idx = addToExternrefTable0(e);
    wasm.__wbindgen_exn_store(idx);
  }
}
function isLikeNone(x) {
  return x === undefined || x === null;
}
function passArrayJsValueToWasm0(array, malloc) {
  const ptr = malloc(array.length * 4, 4) >>> 0;
  for (let i = 0;i < array.length; i++) {
    const add = addToExternrefTable0(array[i]);
    getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
  }
  WASM_VECTOR_LEN = array.length;
  return ptr;
}
function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === undefined) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr2 = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0().subarray(ptr2, ptr2 + buf.length).set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr2;
  }
  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;
  const mem = getUint8ArrayMemory0();
  let offset = 0;
  for (;offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 127)
      break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);
    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }
  WASM_VECTOR_LEN = offset;
  return ptr;
}
function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_externrefs.get(idx);
  wasm.__externref_table_dealloc(idx);
  return value;
}
var cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
var MAX_SAFARI_DECODE_BYTES = 2146435072;
var numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
var cachedTextEncoder = new TextEncoder;
if (!("encodeInto" in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function(arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
      read: arg.length,
      written: buf.length
    };
  };
}
var WASM_VECTOR_LEN = 0;
var WasmEngineFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {}, unregister: () => {} } : new FinalizationRegistry((ptr) => wasm.__wbg_wasmengine_free(ptr >>> 0, 1));

class WasmEngine {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    WasmEngineFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_wasmengine_free(ptr, 0);
  }
  clearTree() {
    wasm.wasmengine_clearTree(this.__wbg_ptr);
  }
  setModule(name, actions, state_keys, initial_state) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayJsValueToWasm0(actions, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayJsValueToWasm0(state_keys, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.wasmengine_setModule(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, initial_state);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  renderInto(source, parent_node_id_str, state_js) {
    const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(parent_node_id_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.wasmengine_renderInto(this.__wbg_ptr, ptr0, len0, ptr1, len1, state_js);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  getRevision() {
    const ret = wasm.wasmengine_getRevision(this.__wbg_ptr);
    return BigInt.asUintN(64, ret);
  }
  updateState(state_patch) {
    const ret = wasm.wasmengine_updateState(this.__wbg_ptr, state_patch);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  renderSource(source) {
    const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmengine_renderSource(this.__wbg_ptr, ptr0, len0);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  dispatchAction(name, payload) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmengine_dispatchAction(this.__wbg_ptr, ptr0, len0, payload);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  registerPrimitive(name) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.wasmengine_registerPrimitive(this.__wbg_ptr, ptr0, len0);
  }
  setRenderCallback(callback) {
    wasm.wasmengine_setRenderCallback(this.__wbg_ptr, callback);
  }
  updateStateSparse(paths_js, values_js) {
    const ret = wasm.wasmengine_updateStateSparse(this.__wbg_ptr, paths_js, values_js);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  debugParseComponent(source) {
    let deferred3_0;
    let deferred3_1;
    try {
      const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      const ret = wasm.wasmengine_debugParseComponent(this.__wbg_ptr, ptr0, len0);
      var ptr2 = ret[0];
      var len2 = ret[1];
      if (ret[3]) {
        ptr2 = 0;
        len2 = 0;
        throw takeFromExternrefTable0(ret[2]);
      }
      deferred3_0 = ptr2;
      deferred3_1 = len2;
      return getStringFromWasm0(ptr2, len2);
    } finally {
      wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
  }
  renderLazyComponent(source) {
    const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmengine_renderLazyComponent(this.__wbg_ptr, ptr0, len0);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  setComponentResolver(resolver) {
    wasm.wasmengine_setComponentResolver(this.__wbg_ptr, resolver);
  }
  constructor() {
    const ret = wasm.wasmengine_new();
    this.__wbg_ptr = ret >>> 0;
    WasmEngineFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  onAction(action_name, handler) {
    const ptr0 = passStringToWasm0(action_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.wasmengine_onAction(this.__wbg_ptr, ptr0, len0, handler);
  }
}
if (Symbol.dispose)
  WasmEngine.prototype[Symbol.dispose] = WasmEngine.prototype.free;
var EXPECTED_RESPONSE_TYPES = new Set(["basic", "cors", "default"]);
async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);
        if (validResponse && module.headers.get("Content-Type") !== "application/wasm") {
          console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
        } else {
          throw e;
        }
      }
    }
    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);
    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }
}
function __wbg_get_imports() {
  const imports = {};
  imports.wbg = {};
  imports.wbg.__wbg_Error_52673b7de5a0ca89 = function(arg0, arg1) {
    const ret = Error(getStringFromWasm0(arg0, arg1));
    return ret;
  };
  imports.wbg.__wbg___wbindgen_bigint_get_as_i64_6e32f5e6aff02e1d = function(arg0, arg1) {
    const v = arg1;
    const ret = typeof v === "bigint" ? v : undefined;
    getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
  };
  imports.wbg.__wbg___wbindgen_boolean_get_dea25b33882b895b = function(arg0) {
    const v = arg0;
    const ret = typeof v === "boolean" ? v : undefined;
    return isLikeNone(ret) ? 16777215 : ret ? 1 : 0;
  };
  imports.wbg.__wbg___wbindgen_debug_string_adfb662ae34724b6 = function(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbg___wbindgen_in_0d3e1e8f0c669317 = function(arg0, arg1) {
    const ret = arg0 in arg1;
    return ret;
  };
  imports.wbg.__wbg___wbindgen_is_bigint_0e1a2e3f55cfae27 = function(arg0) {
    const ret = typeof arg0 === "bigint";
    return ret;
  };
  imports.wbg.__wbg___wbindgen_is_function_8d400b8b1af978cd = function(arg0) {
    const ret = typeof arg0 === "function";
    return ret;
  };
  imports.wbg.__wbg___wbindgen_is_null_dfda7d66506c95b5 = function(arg0) {
    const ret = arg0 === null;
    return ret;
  };
  imports.wbg.__wbg___wbindgen_is_object_ce774f3490692386 = function(arg0) {
    const val = arg0;
    const ret = typeof val === "object" && val !== null;
    return ret;
  };
  imports.wbg.__wbg___wbindgen_is_string_704ef9c8fc131030 = function(arg0) {
    const ret = typeof arg0 === "string";
    return ret;
  };
  imports.wbg.__wbg___wbindgen_is_undefined_f6b95eab589e0269 = function(arg0) {
    const ret = arg0 === undefined;
    return ret;
  };
  imports.wbg.__wbg___wbindgen_jsval_eq_b6101cc9cef1fe36 = function(arg0, arg1) {
    const ret = arg0 === arg1;
    return ret;
  };
  imports.wbg.__wbg___wbindgen_jsval_loose_eq_766057600fdd1b0d = function(arg0, arg1) {
    const ret = arg0 == arg1;
    return ret;
  };
  imports.wbg.__wbg___wbindgen_number_get_9619185a74197f95 = function(arg0, arg1) {
    const obj = arg1;
    const ret = typeof obj === "number" ? obj : undefined;
    getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
  };
  imports.wbg.__wbg___wbindgen_string_get_a2a31e16edf96e42 = function(arg0, arg1) {
    const obj = arg1;
    const ret = typeof obj === "string" ? obj : undefined;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbg___wbindgen_throw_dd24417ed36fc46e = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
  };
  imports.wbg.__wbg_call_3020136f7a2d6e44 = function() {
    return handleError(function(arg0, arg1, arg2) {
      const ret = arg0.call(arg1, arg2);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_call_abb4ff46ce38be40 = function() {
    return handleError(function(arg0, arg1) {
      const ret = arg0.call(arg1);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_call_c8baa5c5e72d274e = function() {
    return handleError(function(arg0, arg1, arg2, arg3) {
      const ret = arg0.call(arg1, arg2, arg3);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_done_62ea16af4ce34b24 = function(arg0) {
    const ret = arg0.done;
    return ret;
  };
  imports.wbg.__wbg_entries_83c79938054e065f = function(arg0) {
    const ret = Object.entries(arg0);
    return ret;
  };
  imports.wbg.__wbg_error_7bc7d576a6aaf855 = function(arg0) {
    console.error(arg0);
  };
  imports.wbg.__wbg_get_6b7bd52aca3f9671 = function(arg0, arg1) {
    const ret = arg0[arg1 >>> 0];
    return ret;
  };
  imports.wbg.__wbg_get_af9dab7e9603ea93 = function() {
    return handleError(function(arg0, arg1) {
      const ret = Reflect.get(arg0, arg1);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_instanceof_ArrayBuffer_f3320d2419cd0355 = function(arg0) {
    let result;
    try {
      result = arg0 instanceof ArrayBuffer;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_instanceof_Map_084be8da74364158 = function(arg0) {
    let result;
    try {
      result = arg0 instanceof Map;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_instanceof_Uint8Array_da54ccc9d3e09434 = function(arg0) {
    let result;
    try {
      result = arg0 instanceof Uint8Array;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_isArray_51fd9e6422c0a395 = function(arg0) {
    const ret = Array.isArray(arg0);
    return ret;
  };
  imports.wbg.__wbg_isSafeInteger_ae7d3f054d55fa16 = function(arg0) {
    const ret = Number.isSafeInteger(arg0);
    return ret;
  };
  imports.wbg.__wbg_iterator_27b7c8b35ab3e86b = function() {
    const ret = Symbol.iterator;
    return ret;
  };
  imports.wbg.__wbg_length_22ac23eaec9d8053 = function(arg0) {
    const ret = arg0.length;
    return ret;
  };
  imports.wbg.__wbg_length_d45040a40c570362 = function(arg0) {
    const ret = arg0.length;
    return ret;
  };
  imports.wbg.__wbg_log_1d990106d99dacb7 = function(arg0) {
    console.log(arg0);
  };
  imports.wbg.__wbg_new_1ba21ce319a06297 = function() {
    const ret = new Object;
    return ret;
  };
  imports.wbg.__wbg_new_25f239778d6112b9 = function() {
    const ret = new Array;
    return ret;
  };
  imports.wbg.__wbg_new_6421f6084cc5bc5a = function(arg0) {
    const ret = new Uint8Array(arg0);
    return ret;
  };
  imports.wbg.__wbg_new_b546ae120718850e = function() {
    const ret = new Map;
    return ret;
  };
  imports.wbg.__wbg_next_138a17bbf04e926c = function(arg0) {
    const ret = arg0.next;
    return ret;
  };
  imports.wbg.__wbg_next_3cfe5c0fe2a4cc53 = function() {
    return handleError(function(arg0) {
      const ret = arg0.next();
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_prototypesetcall_dfe9b766cdc1f1fd = function(arg0, arg1, arg2) {
    Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
  };
  imports.wbg.__wbg_set_3f1d0b984ed272ed = function(arg0, arg1, arg2) {
    arg0[arg1] = arg2;
  };
  imports.wbg.__wbg_set_7df433eea03a5c14 = function(arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
  };
  imports.wbg.__wbg_set_efaaf145b9377369 = function(arg0, arg1, arg2) {
    const ret = arg0.set(arg1, arg2);
    return ret;
  };
  imports.wbg.__wbg_value_57b7b035e117f7ee = function(arg0) {
    const ret = arg0.value;
    return ret;
  };
  imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
  };
  imports.wbg.__wbindgen_cast_4625c577ab2ec9ee = function(arg0) {
    const ret = BigInt.asUintN(64, arg0);
    return ret;
  };
  imports.wbg.__wbindgen_cast_9ae0607507abb057 = function(arg0) {
    const ret = arg0;
    return ret;
  };
  imports.wbg.__wbindgen_cast_d6cd19b81560fd6e = function(arg0) {
    const ret = arg0;
    return ret;
  };
  imports.wbg.__wbindgen_init_externref_table = function() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
  };
  return imports;
}
function __wbg_finalize_init(instance, module) {
  wasm = instance.exports;
  __wbg_init.__wbindgen_wasm_module = module;
  cachedDataViewMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}
async function __wbg_init(module_or_path) {
  if (wasm !== undefined)
    return wasm;
  if (typeof module_or_path !== "undefined") {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn("using deprecated parameters for the initialization function; pass a single object instead");
    }
  }
  if (typeof module_or_path === "undefined") {
    module_or_path = new URL("hypen_engine_bg.wasm", import.meta.url);
  }
  const imports = __wbg_get_imports();
  if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) {
    module_or_path = fetch(module_or_path);
  }
  const { instance, module } = await __wbg_load(await module_or_path, imports);
  return __wbg_finalize_init(instance, module);
}
var hypen_engine_default = __wbg_init;

// src/engine.browser.ts
function mapToObject(value) {
  if (value instanceof Map) {
    const obj = {};
    for (const [key, val] of value.entries()) {
      obj[key] = mapToObject(val);
    }
    return obj;
  } else if (Array.isArray(value)) {
    return value.map(mapToObject);
  } else if (value && typeof value === "object" && value.constructor === Object) {
    const obj = {};
    for (const [key, val] of Object.entries(value)) {
      obj[key] = mapToObject(val);
    }
    return obj;
  }
  return value;
}

class Engine {
  wasmEngine = null;
  initialized = false;
  async init() {
    if (this.initialized)
      return;
    await hypen_engine_default("/hypen_engine_bg.wasm");
    this.wasmEngine = new WasmEngine;
    this.initialized = true;
  }
  ensureInitialized() {
    if (!this.wasmEngine) {
      throw new Error("Engine not initialized. Call init() first.");
    }
    return this.wasmEngine;
  }
  setRenderCallback(callback) {
    const engine = this.ensureInitialized();
    engine.setRenderCallback((patches) => {
      callback(patches);
    });
  }
  setComponentResolver(resolver) {
    const engine = this.ensureInitialized();
    engine.setComponentResolver((componentName, contextPath) => {
      const result = resolver(componentName, contextPath);
      return result;
    });
  }
  renderSource(source) {
    const engine = this.ensureInitialized();
    engine.renderSource(source);
  }
  renderLazyComponent(source) {
    const engine = this.ensureInitialized();
    engine.renderLazyComponent(source);
  }
  renderInto(source, parentNodeId, state) {
    const engine = this.ensureInitialized();
    const safeState = JSON.parse(JSON.stringify(state));
    engine.renderInto(source, parentNodeId, safeState);
  }
  notifyStateChange(paths, currentState) {
    const engine = this.ensureInitialized();
    const plainObject = JSON.parse(JSON.stringify(currentState));
    engine.updateState(plainObject);
    if (paths.length > 0) {
      console.debug("[Hypen] State changed:", paths);
    }
  }
  updateState(statePatch) {
    const engine = this.ensureInitialized();
    const plainObject = JSON.parse(JSON.stringify(statePatch));
    engine.updateState(plainObject);
  }
  dispatchAction(name, payload) {
    const engine = this.ensureInitialized();
    console.log(`\uD83D\uDD04 [Engine] Action dispatched: ${name}`);
    engine.dispatchAction(name, payload ?? null);
  }
  onAction(actionName, handler) {
    const engine = this.ensureInitialized();
    engine.onAction(actionName, (action) => {
      const normalizedAction = {
        ...action,
        payload: action.payload ? mapToObject(action.payload) : action.payload
      };
      Promise.resolve(handler(normalizedAction)).catch(console.error);
    });
  }
  setModule(name, actions, stateKeys, initialState) {
    const engine = this.ensureInitialized();
    engine.setModule(name, actions, stateKeys, initialState);
  }
  getRevision() {
    const engine = this.ensureInitialized();
    return engine.getRevision();
  }
  clearTree() {
    const engine = this.ensureInitialized();
    engine.clearTree();
  }
  debugParseComponent(source) {
    const engine = this.ensureInitialized();
    return engine.debugParseComponent(source);
  }
}

// src/state.ts
function deepClone(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  const visited = new WeakMap;
  function cloneInternal(value) {
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (visited.has(value)) {
      return visited.get(value);
    }
    if (value instanceof Date) {
      return new Date(value.getTime());
    }
    if (value instanceof RegExp) {
      return new RegExp(value.source, value.flags);
    }
    if (value instanceof Map) {
      const mapClone = new Map;
      visited.set(value, mapClone);
      for (const [k, v] of value.entries()) {
        mapClone.set(cloneInternal(k), cloneInternal(v));
      }
      return mapClone;
    }
    if (value instanceof Set) {
      const setClone = new Set;
      visited.set(value, setClone);
      for (const item of value.values()) {
        setClone.add(cloneInternal(item));
      }
      return setClone;
    }
    if (value instanceof WeakMap || value instanceof WeakSet) {
      return value;
    }
    if (Array.isArray(value)) {
      const arrClone = [];
      visited.set(value, arrClone);
      for (let i = 0;i < value.length; i++) {
        arrClone[i] = cloneInternal(value[i]);
      }
      return arrClone;
    }
    const objClone = {};
    visited.set(value, objClone);
    for (const key in value) {
      if (value.hasOwnProperty(key)) {
        objClone[key] = cloneInternal(value[key]);
      }
    }
    return objClone;
  }
  return cloneInternal(obj);
}
function diffState(oldState, newState, basePath = "") {
  const paths = [];
  const newValues = {};
  function diff(oldVal, newVal, path) {
    if (oldVal === newVal)
      return;
    if (typeof oldVal !== "object" || typeof newVal !== "object" || oldVal === null || newVal === null) {
      if (oldVal !== newVal) {
        paths.push(path);
        newValues[path] = newVal;
      }
      return;
    }
    if (Array.isArray(oldVal) || Array.isArray(newVal)) {
      if (!Array.isArray(oldVal) || !Array.isArray(newVal) || oldVal.length !== newVal.length) {
        paths.push(path);
        newValues[path] = newVal;
        return;
      }
      for (let i = 0;i < newVal.length; i++) {
        const itemPath = path ? `${path}.${i}` : `${i}`;
        diff(oldVal[i], newVal[i], itemPath);
      }
      return;
    }
    const oldKeys = new Set(Object.keys(oldVal));
    const newKeys = new Set(Object.keys(newVal));
    for (const key of newKeys) {
      const propPath = path ? `${path}.${key}` : key;
      if (!oldKeys.has(key)) {
        paths.push(propPath);
        newValues[propPath] = newVal[key];
      } else {
        diff(oldVal[key], newVal[key], propPath);
      }
    }
    for (const key of oldKeys) {
      if (!newKeys.has(key)) {
        const propPath = path ? `${path}.${key}` : key;
        paths.push(propPath);
        newValues[propPath] = undefined;
      }
    }
  }
  diff(oldState, newState, basePath);
  return { paths, newValues };
}
function createObservableState(initialState, options) {
  const opts = options || { onChange: () => {} };
  if (initialState instanceof Number || initialState instanceof String || initialState instanceof Boolean) {
    throw new TypeError("Cannot create observable state from primitive wrapper objects (Number, String, Boolean). " + "Use plain primitives or regular objects instead.");
  }
  let lastSnapshot = deepClone(initialState);
  const pathPrefix = opts.pathPrefix || "";
  let batchDepth = 0;
  let pendingChange = null;
  function notifyChange() {
    if (batchDepth > 0)
      return;
    const change = diffState(lastSnapshot, state, pathPrefix);
    if (change.paths.length > 0) {
      lastSnapshot = deepClone(state);
      if (pendingChange) {
        change.paths.push(...pendingChange.paths);
        Object.assign(change.newValues, pendingChange.newValues);
        pendingChange = null;
      }
      opts.onChange(change);
    }
  }
  let notificationPending = false;
  function scheduleBatch() {
    if (batchDepth === 0) {
      if (!notificationPending) {
        notificationPending = true;
        queueMicrotask(() => {
          notificationPending = false;
          if (batchDepth === 0) {
            notifyChange();
          }
        });
      }
    }
  }
  const proxyCache = new WeakMap;
  function createProxy(target, basePath) {
    if (proxyCache.has(target)) {
      return proxyCache.get(target);
    }
    const proxy = new Proxy(target, {
      get(obj, prop) {
        const value = obj[prop];
        if (prop === "__beginBatch") {
          return () => {
            batchDepth++;
          };
        }
        if (prop === "__endBatch") {
          return () => {
            batchDepth--;
            if (batchDepth === 0) {
              notifyChange();
            }
          };
        }
        if (prop === "__getSnapshot") {
          return () => deepClone(obj);
        }
        if (value && typeof value === "object") {
          if (value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet) {
            return value;
          }
          return createProxy(value, basePath ? `${basePath}.${String(prop)}` : String(prop));
        }
        return value;
      },
      set(obj, prop, value) {
        const oldValue = obj[prop];
        obj[prop] = value;
        if (oldValue !== value) {
          scheduleBatch();
        }
        return true;
      },
      deleteProperty(obj, prop) {
        if (prop in obj) {
          delete obj[prop];
          scheduleBatch();
        }
        return true;
      }
    });
    proxyCache.set(target, proxy);
    return proxy;
  }
  const state = createProxy(initialState, pathPrefix);
  return state;
}
function getStateSnapshot(state) {
  const s = state;
  if (s.__getSnapshot) {
    return s.__getSnapshot();
  }
  return deepClone(state);
}

// src/app.ts
class HypenAppBuilder {
  initialState;
  options;
  createdHandler;
  actionHandlers = new Map;
  destroyedHandler;
  constructor(initialState, options) {
    this.initialState = initialState;
    this.options = options || {};
  }
  onCreated(fn) {
    this.createdHandler = fn;
    return this;
  }
  onAction(name, fn) {
    this.actionHandlers.set(name, fn);
    return this;
  }
  onDestroyed(fn) {
    this.destroyedHandler = fn;
    return this;
  }
  build() {
    const stateKeys = this.initialState !== null && typeof this.initialState === "object" ? Object.keys(this.initialState) : [];
    return {
      name: this.options.name,
      actions: Array.from(this.actionHandlers.keys()),
      stateKeys,
      persist: this.options.persist,
      version: this.options.version,
      initialState: this.initialState,
      handlers: {
        onCreated: this.createdHandler,
        onAction: this.actionHandlers,
        onDestroyed: this.destroyedHandler
      }
    };
  }
}

class HypenApp {
  defineState(initial, options) {
    return new HypenAppBuilder(initial, options);
  }
}
var app = new HypenApp;

// src/dom/components/index.ts
class ComponentRegistry {
  handlers = new Map;
  constructor() {
    this.registerDefaults();
  }
  register(type, handler) {
    this.handlers.set(type.toLowerCase(), handler);
  }
  get(type) {
    return this.handlers.get(type.toLowerCase());
  }
  createElement(type, props = {}) {
    const handler = this.get(type);
    if (!handler)
      return null;
    const element = handler.create();
    if (handler.applyProps) {
      handler.applyProps(element, props);
    }
    return element;
  }
  registerDefaults() {
    const { columnHandler: columnHandler2 } = (init_column(), __toCommonJS(exports_column));
    const { rowHandler: rowHandler2 } = (init_row(), __toCommonJS(exports_row));
    const { textHandler: textHandler2 } = (init_text(), __toCommonJS(exports_text));
    const { imageHandler: imageHandler2 } = (init_image(), __toCommonJS(exports_image));
    const { buttonHandler: buttonHandler2 } = (init_button(), __toCommonJS(exports_button));
    const { containerHandler: containerHandler2 } = (init_container(), __toCommonJS(exports_container));
    const { centerHandler: centerHandler2 } = (init_center(), __toCommonJS(exports_center));
    const { listHandler: listHandler2 } = (init_list(), __toCommonJS(exports_list));
    const { inputHandler: inputHandler2 } = (init_input(), __toCommonJS(exports_input));
    const { linkHandler: linkHandler2 } = (init_link(), __toCommonJS(exports_link));
    const { textareaHandler: textareaHandler2 } = (init_textarea(), __toCommonJS(exports_textarea));
    const { checkboxHandler: checkboxHandler2 } = (init_checkbox(), __toCommonJS(exports_checkbox));
    const { selectHandler: selectHandler2 } = (init_select(), __toCommonJS(exports_select));
    const { spacerHandler: spacerHandler2 } = (init_spacer(), __toCommonJS(exports_spacer));
    const { stackHandler: stackHandler2 } = (init_stack(), __toCommonJS(exports_stack));
    const { dividerHandler: dividerHandler2 } = (init_divider(), __toCommonJS(exports_divider));
    const { gridHandler: gridHandler2 } = (init_grid(), __toCommonJS(exports_grid));
    const { cardHandler: cardHandler2 } = (init_card(), __toCommonJS(exports_card));
    const { headingHandler: headingHandler2 } = (init_heading(), __toCommonJS(exports_heading));
    const { switchHandler: switchHandler2 } = (init_switch(), __toCommonJS(exports_switch));
    const { sliderHandler: sliderHandler2 } = (init_slider(), __toCommonJS(exports_slider));
    const { spinnerHandler: spinnerHandler2 } = (init_spinner(), __toCommonJS(exports_spinner));
    const { badgeHandler: badgeHandler2 } = (init_badge(), __toCommonJS(exports_badge));
    const { avatarHandler: avatarHandler2 } = (init_avatar(), __toCommonJS(exports_avatar));
    const { progressBarHandler: progressBarHandler2 } = (init_progressbar(), __toCommonJS(exports_progressbar));
    const { videoHandler: videoHandler2 } = (init_video(), __toCommonJS(exports_video));
    const { audioHandler: audioHandler2 } = (init_audio(), __toCommonJS(exports_audio));
    const { paragraphHandler: paragraphHandler2 } = (init_paragraph(), __toCommonJS(exports_paragraph));
    const { routerHandler: routerHandler2 } = (init_router(), __toCommonJS(exports_router));
    const { routeHandler: routeHandler2 } = (init_route(), __toCommonJS(exports_route));
    this.register("column", columnHandler2);
    this.register("row", rowHandler2);
    this.register("text", textHandler2);
    this.register("image", imageHandler2);
    this.register("button", buttonHandler2);
    this.register("container", containerHandler2);
    this.register("box", containerHandler2);
    this.register("center", centerHandler2);
    this.register("list", listHandler2);
    this.register("input", inputHandler2);
    this.register("link", linkHandler2);
    this.register("textarea", textareaHandler2);
    this.register("checkbox", checkboxHandler2);
    this.register("select", selectHandler2);
    this.register("spacer", spacerHandler2);
    this.register("stack", stackHandler2);
    this.register("divider", dividerHandler2);
    this.register("grid", gridHandler2);
    this.register("card", cardHandler2);
    this.register("heading", headingHandler2);
    this.register("switch", switchHandler2);
    this.register("slider", sliderHandler2);
    this.register("spinner", spinnerHandler2);
    this.register("badge", badgeHandler2);
    this.register("avatar", avatarHandler2);
    this.register("progressbar", progressBarHandler2);
    this.register("video", videoHandler2);
    this.register("audio", audioHandler2);
    this.register("paragraph", paragraphHandler2);
    this.register("router", routerHandler2);
    this.register("route", routeHandler2);
  }
}

// src/dom/applicators/index.ts
class ApplicatorRegistry {
  handlers = new Map;
  elementState = new WeakMap;
  constructor() {
    this.registerDefaults();
  }
  register(name, handler) {
    this.handlers.set(name, handler);
  }
  apply(element, name, value) {
    const { handlerName, argKey, aggregate, fallbackName } = this.parseApplicatorName(name);
    const handler = this.handlers.get(handlerName);
    const state = this.getElementState(element);
    const previous = state.get(handlerName);
    if (aggregate && argKey !== null) {
      const merged = this.mergeAggregateState(previous, argKey, this.normalizeValue(value));
      state.set(handlerName, merged);
      if (handler) {
        handler(element, merged);
      } else {
        this.setStyleProperty(element, fallbackName, value);
      }
      return;
    }
    if (handler) {
      if (this.isEventApplicator(handlerName)) {
        const normalizedValue = this.normalizeEventValue(previous, value);
        state.set(handlerName, normalizedValue);
        handler(element, normalizedValue);
      } else {
        state.set(handlerName, value);
        handler(element, value);
      }
    } else {
      this.setStyleProperty(element, handlerName, value);
    }
  }
  parseApplicatorName(name) {
    const dotIndex = name.indexOf(".");
    if (dotIndex === -1) {
      return { handlerName: name, argKey: null, aggregate: false, fallbackName: name };
    }
    const baseName = name.substring(0, dotIndex);
    const argKey = name.substring(dotIndex + 1);
    if (this.handlers.has(baseName) && this.isEventApplicator(baseName)) {
      return { handlerName: baseName, argKey, aggregate: true, fallbackName: name };
    }
    if (/^\d+$/.test(argKey)) {
      return { handlerName: baseName, argKey: null, aggregate: false, fallbackName: baseName };
    }
    return { handlerName: name, argKey: null, aggregate: false, fallbackName: name };
  }
  getElementState(element) {
    let state = this.elementState.get(element);
    if (!state) {
      state = new Map;
      this.elementState.set(element, state);
    }
    return state;
  }
  mergeAggregateState(previous, argKey, value) {
    const base = this.cloneAggregateState(previous);
    if (value === undefined) {
      delete base[argKey];
    } else {
      base[argKey] = value;
    }
    return base;
  }
  cloneAggregateState(previous) {
    if (previous && typeof previous === "object" && !Array.isArray(previous)) {
      return { ...previous };
    }
    if (typeof previous === "string") {
      return { "0": previous };
    }
    return {};
  }
  normalizeEventValue(previous, value) {
    const normalizedInput = this.normalizeValue(value);
    const base = this.cloneAggregateState(previous);
    if (normalizedInput && typeof normalizedInput === "object" && !Array.isArray(normalizedInput)) {
      const next = { ...base, ...normalizedInput };
      if (!Object.prototype.hasOwnProperty.call(next, "0") && base["0"] !== undefined) {
        next["0"] = base["0"];
      }
      return next;
    }
    if (normalizedInput !== undefined) {
      base["0"] = normalizedInput;
    }
    return base;
  }
  normalizeValue(value) {
    if (value instanceof Map) {
      const obj = {};
      for (const [key, val] of value.entries()) {
        obj[key] = this.normalizeValue(val);
      }
      return obj;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeValue(item));
    }
    if (value && typeof value === "object") {
      const obj = {};
      for (const [key, val] of Object.entries(value)) {
        obj[key] = this.normalizeValue(val);
      }
      return obj;
    }
    return value;
  }
  isEventApplicator(name) {
    return /^on[A-Z]/.test(name);
  }
  applyAll(element, applicators) {
    const grouped = new Map;
    for (const [name, value] of Object.entries(applicators)) {
      const dotIndex = name.indexOf(".");
      const baseName = dotIndex !== -1 ? name.substring(0, dotIndex) : name;
      const argKey = dotIndex !== -1 ? name.substring(dotIndex + 1) : null;
      if (!grouped.has(baseName)) {
        grouped.set(baseName, {});
      }
      const args = grouped.get(baseName);
      if (argKey !== null) {
        args[argKey] = value;
      } else {
        args["__value"] = value;
      }
    }
    for (const [baseName, args] of grouped.entries()) {
      if (Object.keys(args).length === 1) {
        if ("__value" in args) {
          this.apply(element, baseName, args["__value"]);
        } else if ("0" in args) {
          this.apply(element, baseName, args["0"]);
        } else {
          this.apply(element, baseName, args);
        }
      } else {
        this.apply(element, baseName, args);
      }
    }
  }
  setStyleProperty(element, name, value) {
    const cssName = name.replace(/([A-Z])/g, "-$1").toLowerCase();
    if (typeof value === "number" && this.needsUnit(cssName)) {
      element.style.setProperty(cssName, `${value}px`);
    } else {
      element.style.setProperty(cssName, String(value));
    }
  }
  needsUnit(prop) {
    const unitless = [
      "opacity",
      "z-index",
      "font-weight",
      "line-height",
      "flex",
      "flex-grow",
      "flex-shrink",
      "order"
    ];
    return !unitless.includes(prop);
  }
  registerDefaults() {
    const { paddingHandler: paddingHandler2 } = __toCommonJS(exports_padding);
    const { marginHandler: marginHandler2 } = __toCommonJS(exports_margin);
    const { colorHandlers: colorHandlers2 } = (init_color(), __toCommonJS(exports_color));
    const { borderHandlers: borderHandlers2 } = (init_border(), __toCommonJS(exports_border));
    const { sizeHandlers: sizeHandlers2 } = (init_size(), __toCommonJS(exports_size));
    const { fontHandlers: fontHandlers2 } = (init_font(), __toCommonJS(exports_font));
    const { layoutHandlers: layoutHandlers2 } = (init_layout(), __toCommonJS(exports_layout));
    const { eventHandlers: eventHandlers2 } = (init_events(), __toCommonJS(exports_events));
    const { typographyHandlers: typographyHandlers2 } = (init_typography(), __toCommonJS(exports_typography));
    const { transformHandlers: transformHandlers2 } = (init_transform(), __toCommonJS(exports_transform));
    const { effectsHandlers: effectsHandlers2 } = (init_effects(), __toCommonJS(exports_effects));
    const { advancedLayoutHandlers: advancedLayoutHandlers2 } = (init_advanced_layout(), __toCommonJS(exports_advanced_layout));
    const { backgroundHandlers: backgroundHandlers2 } = (init_background(), __toCommonJS(exports_background));
    const { displayHandlers: displayHandlers2 } = (init_display(), __toCommonJS(exports_display));
    const { transitionHandlers: transitionHandlers2 } = (init_transition(), __toCommonJS(exports_transition));
    this.register("padding", paddingHandler2);
    this.register("margin", marginHandler2);
    for (const [name, handler] of Object.entries(colorHandlers2)) {
      this.register(name, handler);
    }
    for (const [name, handler] of Object.entries(borderHandlers2)) {
      this.register(name, handler);
    }
    for (const [name, handler] of Object.entries(sizeHandlers2)) {
      this.register(name, handler);
    }
    for (const [name, handler] of Object.entries(fontHandlers2)) {
      this.register(name, handler);
    }
    for (const [name, handler] of Object.entries(layoutHandlers2)) {
      this.register(name, handler);
    }
    for (const [name, handler] of Object.entries(eventHandlers2)) {
      this.register(name, handler);
    }
    for (const [name, handler] of Object.entries(typographyHandlers2)) {
      this.register(name, handler);
    }
    for (const [name, handler] of Object.entries(transformHandlers2)) {
      this.register(name, handler);
    }
    for (const [name, handler] of Object.entries(effectsHandlers2)) {
      this.register(name, handler);
    }
    for (const [name, handler] of Object.entries(advancedLayoutHandlers2)) {
      this.register(name, handler);
    }
    for (const [name, handler] of Object.entries(backgroundHandlers2)) {
      this.register(name, handler);
    }
    for (const [name, handler] of Object.entries(displayHandlers2)) {
      this.register(name, handler);
    }
    for (const [name, handler] of Object.entries(transitionHandlers2)) {
      this.register(name, handler);
    }
  }
}

// src/dom/canvas/index.ts
var canvasHandler = {
  create() {
    const el = document.createElement("canvas");
    el.dataset.hypenType = "canvas";
    return el;
  },
  applyProps(el, props) {
    const canvas = el;
    if (props.width !== undefined) {
      canvas.width = Number(props.width);
    }
    if (props.height !== undefined) {
      canvas.height = Number(props.height);
    }
  }
};
var canvasApplicators = {
  fillStyle: (el, value) => {
    const canvas = el;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = String(value);
    }
  },
  strokeStyle: (el, value) => {
    const canvas = el;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.strokeStyle = String(value);
    }
  },
  lineWidth: (el, value) => {
    const canvas = el;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.lineWidth = Number(value);
    }
  }
};

// src/dom/debug.ts
var defaultDebugConfig = {
  enabled: false,
  showHeatmap: true,
  heatmapIncrement: 5,
  maxOpacity: 0.8,
  fadeOutDuration: 2000
};

class RerenderTracker {
  renderCounts = new Map;
  overlays = new Map;
  config;
  constructor(config = defaultDebugConfig) {
    this.config = config;
  }
  setConfig(config) {
    this.config = { ...this.config, ...config };
    if (!this.config.enabled) {
      this.cleanup();
    }
  }
  trackRerender(id, element, patchType) {
    if (!this.config.enabled || !this.config.showHeatmap) {
      return;
    }
    console.log(`\uD83D\uDD25 [Debug] Tracking re-render: ${id} - ${patchType}`);
    const currentCount = this.renderCounts.get(id) || 0;
    const newCount = currentCount + 1;
    this.renderCounts.set(id, newCount);
    this.updateHeatmap(id, element, newCount, patchType);
  }
  updateHeatmap(id, element, renderCount, patchType) {
    const opacity = Math.min(renderCount * this.config.heatmapIncrement / 100, this.config.maxOpacity);
    console.log(`\uD83D\uDD25 [Debug] Updating heatmap for ${id}, count: ${renderCount}, opacity: ${opacity}`);
    const isInline = window.getComputedStyle(element).display.includes("inline");
    if (isInline || element.tagName === "SPAN") {
      if (!element.dataset.hypenDebugOriginalBg) {
        element.dataset.hypenDebugOriginalBg = element.style.backgroundColor || "";
        element.dataset.hypenDebugOriginalOutline = element.style.outline || "";
        element.dataset.hypenDebugOriginalPosition = element.style.position || "";
      }
      element.style.backgroundColor = `rgba(255, 0, 0, ${Math.max(opacity, 0.15)})`;
      element.style.outline = `2px solid rgba(255, 0, 0, ${Math.max(opacity + 0.2, 0.3)})`;
      element.style.outlineOffset = "2px";
      element.style.position = "relative";
      element.setAttribute("data-hypen-renders", `${renderCount}× ${patchType}`);
      if (!document.getElementById("hypen-debug-styles")) {
        const style = document.createElement("style");
        style.id = "hypen-debug-styles";
        style.textContent = `
          [data-hypen-renders]::before {
            content: attr(data-hypen-renders);
            position: absolute;
            top: -18px;
            left: 0;
            background: rgba(255, 0, 0, 0.9);
            color: white;
            padding: 2px 6px;
            font-size: 10px;
            font-family: 'Courier New', monospace;
            font-weight: bold;
            border-radius: 3px;
            z-index: 999999;
            pointer-events: none;
            white-space: nowrap;
            text-shadow: none;
          }
        `;
        document.head.appendChild(style);
      }
      this.overlays.set(id, element);
      if (this.config.fadeOutDuration > 0) {
        setTimeout(() => {
          const originalBg = element.dataset.hypenDebugOriginalBg || "";
          const originalOutline = element.dataset.hypenDebugOriginalOutline || "";
          element.style.backgroundColor = originalBg;
          element.style.outline = originalOutline;
          element.style.opacity = "1";
        }, this.config.fadeOutDuration);
      }
    } else {
      let overlay = this.overlays.get(id);
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.className = "hypen-debug-overlay";
        overlay.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          pointer-events: none;
          z-index: 999999 !important;
          transition: opacity ${this.config.fadeOutDuration}ms ease-out;
          border: 2px solid rgba(255, 0, 0, 0.7) !important;
          box-sizing: border-box;
          font-size: 11px;
          color: white;
          text-shadow: 0 0 3px black, 0 0 5px black;
          padding: 4px;
          font-family: 'Courier New', monospace;
          font-weight: bold;
          display: block !important;
          visibility: visible !important;
        `;
        const currentPosition = window.getComputedStyle(element).position;
        if (currentPosition === "static") {
          element.style.position = "relative";
        }
        element.appendChild(overlay);
        this.overlays.set(id, overlay);
      }
      overlay.style.backgroundColor = `rgba(255, 0, 0, ${Math.max(opacity, 0.15)})`;
      overlay.style.opacity = "1";
      overlay.textContent = `${renderCount}× ${patchType}`;
      if (this.config.fadeOutDuration > 0) {
        setTimeout(() => {
          if (overlay) {
            overlay.style.opacity = "0.2";
          }
        }, this.config.fadeOutDuration);
      }
    }
  }
  reset(id) {
    this.renderCounts.delete(id);
    const overlay = this.overlays.get(id);
    if (overlay) {
      overlay.remove();
      this.overlays.delete(id);
    }
  }
  resetAll() {
    this.renderCounts.clear();
    for (const overlay of this.overlays.values()) {
      overlay.remove();
    }
    this.overlays.clear();
  }
  getRenderCount(id) {
    return this.renderCounts.get(id) || 0;
  }
  cleanup() {
    for (const overlay of this.overlays.values()) {
      overlay.remove();
    }
    this.overlays.clear();
  }
  getStats() {
    const totalRerenders = Array.from(this.renderCounts.values()).reduce((sum, count) => sum + count, 0);
    const elementCount = this.renderCounts.size;
    const avgRerenders = elementCount > 0 ? totalRerenders / elementCount : 0;
    return {
      totalRerenders,
      elementCount,
      avgRerenders: Math.round(avgRerenders * 100) / 100
    };
  }
}

// src/dom/renderer.ts
class DOMRenderer {
  container;
  nodes = new Map;
  rootId = null;
  components;
  applicators;
  engine;
  currentState = {};
  routerContext = null;
  globalContext = null;
  componentInstances = new Map;
  debugTracker;
  constructor(container, engine, debugConfig) {
    this.container = container;
    this.engine = engine;
    this.components = new ComponentRegistry;
    this.applicators = new ApplicatorRegistry;
    this.debugTracker = new RerenderTracker({ ...defaultDebugConfig, ...debugConfig });
    this.components.register("canvas", canvasHandler);
    for (const [name, handler] of Object.entries(canvasApplicators)) {
      this.applicators.register(name, handler);
    }
  }
  setContext(routerContext, globalContext) {
    this.routerContext = routerContext;
    this.globalContext = globalContext;
  }
  applyPatches(patches) {
    for (const patch of patches) {
      this.applyPatch(patch);
    }
  }
  updateState(state) {
    console.log(`\uD83D\uDD04 [Renderer] Updating state:`, state);
    this.currentState = state;
    this.interpolateAllText();
  }
  mergeComponentState(componentState) {
    this.currentState = { ...this.currentState, ...componentState };
    console.log(`\uD83D\uDD04 [Renderer] Merged state:`, this.currentState);
    this.interpolateAllText();
  }
  interpolateAllText() {
    let interpolatedCount = 0;
    for (const [id, element] of this.nodes.entries()) {
      if (element.dataset.hypenType === "text" && element.dataset.textTemplate) {
        const template = element.dataset.textTemplate;
        const interpolated = this.interpolateText(template, this.currentState);
        const currentText = element.textContent;
        if (currentText !== interpolated) {
          this.debugTracker.trackRerender(id, element, "interpolate");
        }
        element.textContent = interpolated;
        interpolatedCount++;
      }
    }
  }
  interpolateText(template, state) {
    return template.replace(/\$\{([^}]+)\}/g, (match, path) => {
      try {
        const value = path.split(".").reduce((obj, key) => {
          if (key === "state")
            return state;
          return obj?.[key];
        }, state);
        return value !== undefined ? String(value) : match;
      } catch {
        return match;
      }
    });
  }
  applyPatch(patch) {
    switch (patch.type) {
      case "create":
        this.onCreate(patch.id, patch.element_type, patch.props || {});
        break;
      case "setProp":
        this.onSetProp(patch.id, patch.name, patch.value);
        break;
      case "setText":
        this.onSetText(patch.id, patch.text);
        break;
      case "insert":
        this.onInsert(patch.parent_id, patch.id, patch.before_id);
        break;
      case "move":
        this.onMove(patch.parent_id, patch.id, patch.before_id);
        break;
      case "remove":
        this.onRemove(patch.id);
        break;
    }
  }
  onCreate(id, elementType, props) {
    const propsObj = props instanceof Map ? Object.fromEntries(props) : props;
    const element = this.components.createElement(elementType, propsObj);
    if (!element) {
      const fallback = document.createElement("div");
      fallback.dataset.hypenType = elementType;
      fallback.textContent = `Unknown component: ${elementType}`;
      this.nodes.set(id, fallback);
      return;
    }
    element.dataset.hypenType = elementType.toLowerCase();
    element.dataset.hypenId = id;
    element.__hypenEngine = this.engine;
    this.applicators.applyAll(element, propsObj);
    this.nodes.set(id, element);
    this.debugTracker.trackRerender(id, element, `create:${elementType}`);
    if (!this.rootId) {
      this.rootId = id;
      if (!this.container.contains(element)) {
        this.container.appendChild(element);
      }
    }
  }
  onSetProp(id, name, value) {
    const element = this.nodes.get(id);
    if (!element)
      return;
    this.debugTracker.trackRerender(id, element, `setProp:${name}`);
    if (name === "0" || name === "text") {
      const elementType = element.dataset.hypenType;
      if (elementType === "input") {
        const inputEl = element;
        inputEl.value = String(value);
        console.log(`\uD83D\uDCDD [Renderer] Updated input value: "${value}"`);
        return;
      }
      element.textContent = String(value);
      if (element.dataset.textTemplate !== undefined) {
        element.dataset.textTemplate = String(value);
      }
      console.log(`\uD83D\uDCDD [Renderer] Updated text content: "${value}"`);
      return;
    }
    this.applicators.apply(element, name, value);
  }
  onSetText(id, text) {
    const element = this.nodes.get(id);
    if (!element)
      return;
    this.debugTracker.trackRerender(id, element, "setText");
    element.textContent = text;
  }
  onInsert(parentId, id, beforeId) {
    const parent = parentId === "root" ? this.container : this.nodes.get(parentId);
    const child = this.nodes.get(id);
    console.log(`\uD83D\uDD17 [Renderer] Inserting ${id} into ${parentId}`, {
      parent: parent ? `${parent.tagName}#${parent.id || "no-id"}` : "null",
      child: child ? `${child.tagName}#${child.id || "no-id"}` : "null",
      childText: child?.textContent?.substring(0, 20)
    });
    if (!parent || !child)
      return;
    if (parentId === "root") {
      this.rootId = id;
    }
    if (beforeId) {
      const before = this.nodes.get(beforeId);
      if (before && before.parentNode === parent) {
        parent.insertBefore(child, before);
      } else if (!parent.contains(child)) {
        parent.appendChild(child);
      }
    } else {
      if (!parent.contains(child)) {
        parent.appendChild(child);
      }
    }
  }
  onMove(parentId, id, beforeId) {
    this.onInsert(parentId, id, beforeId);
  }
  onRemove(id) {
    const element = this.nodes.get(id);
    if (!element)
      return;
    if (element.parentNode) {
      element.parentNode.removeChild(element);
    }
    this.nodes.delete(id);
    if (this.rootId === id) {
      this.rootId = null;
    }
  }
  getNode(id) {
    return this.nodes.get(id);
  }
  clear() {
    this.container.innerHTML = "";
    this.nodes.clear();
    this.rootId = null;
  }
  getComponentRegistry() {
    return this.components;
  }
  getApplicatorRegistry() {
    return this.applicators;
  }
  setDebugConfig(config) {
    this.debugTracker.setConfig(config);
  }
  resetDebugTracking() {
    this.debugTracker.resetAll();
  }
  getDebugStats() {
    return this.debugTracker.getStats();
  }
}
// src/dom/events.ts
class EventManager {
  engine;
  bindings = new Map;
  constructor(engine) {
    this.engine = engine;
  }
  attach(elementId, element, eventName, actionName) {
    const domEventName = eventName === "onClick" ? "click" : eventName;
    console.log(`[EventManager] Attaching ${eventName} (DOM: ${domEventName}) to element ${elementId}, action: ${actionName}`);
    const listener = (event) => {
      console.log(`\uD83D\uDD25 [EventManager] Event fired: ${eventName} on ${elementId}, dispatching action: ${actionName}`);
      console.log(`\uD83D\uDD25 [EventManager] Event object:`, event);
      console.log(`\uD83D\uDD25 [EventManager] Element:`, element);
      if (eventName === "submit" || eventName === "click" && element.tagName === "A") {
        event.preventDefault();
      }
      const payload = this.extractEventData(event, element);
      console.log(`\uD83D\uDD25 [EventManager] Event payload:`, payload);
      console.log(`\uD83D\uDD25 [EventManager] Calling engine.dispatchAction(${actionName})`);
      try {
        this.engine.dispatchAction(actionName, payload);
        console.log(`\uD83D\uDD25 [EventManager] ✅ dispatchAction succeeded`);
      } catch (error) {
        console.error(`\uD83D\uDD25 [EventManager] ❌ dispatchAction failed:`, error);
      }
    };
    let elementBindings = this.bindings.get(elementId);
    if (!elementBindings) {
      elementBindings = new Map;
      this.bindings.set(elementId, elementBindings);
    }
    elementBindings.set(eventName, listener);
    element.addEventListener(domEventName, listener);
    console.log(`[EventManager] Listener attached to DOM for ${domEventName}`);
    console.log(`[EventManager] Element details:`, {
      tagName: element.tagName,
      id: element.id,
      dataset: element.dataset,
      textContent: element.textContent?.substring(0, 50)
    });
    if (domEventName === "click") {
      element.addEventListener("click", (e) => {
        console.log(`\uD83E\uDDEA [TEST] Raw DOM click detected on ${element.tagName}`, e);
      });
    }
  }
  detach(elementId, element, eventName) {
    const elementBindings = this.bindings.get(elementId);
    if (!elementBindings)
      return;
    const listener = elementBindings.get(eventName);
    if (listener) {
      element.removeEventListener(eventName, listener);
      elementBindings.delete(eventName);
    }
    if (elementBindings.size === 0) {
      this.bindings.delete(elementId);
    }
  }
  extractEventData(event, element) {
    const data = {
      type: event.type,
      timestamp: Date.now()
    };
    if (event instanceof MouseEvent) {
      data.clientX = event.clientX;
      data.clientY = event.clientY;
      data.button = event.button;
    }
    if (event instanceof KeyboardEvent) {
      data.key = event.key;
      data.code = event.code;
      data.ctrlKey = event.ctrlKey;
      data.shiftKey = event.shiftKey;
      data.altKey = event.altKey;
      data.metaKey = event.metaKey;
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      data.value = element.value;
    }
    if (element instanceof HTMLSelectElement) {
      data.value = element.value;
      data.selectedIndex = element.selectedIndex;
    }
    if (event.type === "submit" && element instanceof HTMLFormElement) {
      data.formData = new FormData(element);
    }
    return data;
  }
  clearElement(elementId, element) {
    const elementBindings = this.bindings.get(elementId);
    if (!elementBindings)
      return;
    for (const [eventName, listener] of elementBindings) {
      element.removeEventListener(eventName, listener);
    }
    this.bindings.delete(elementId);
  }
  clearAll() {
    this.bindings.clear();
  }
}
// playground/samples.ts
var samples = {
  counter: {
    name: "Counter",
    hypen: `Column {
  Text("Count: @{state.count}")
    .fontSize(24)
    .fontWeight("bold")
    .margin(16)

  Row {
    Button {
      Text("-")
        .fontSize(20)
        .padding(8)
    }
      .onClick("@actions.decrement")
      .margin(4)

    Button {
      Text("Reset")
        .padding(8)
    }
      .onClick("@actions.reset")
      .margin(4)

    Button {
      Text("+")
        .fontSize(20)
        .padding(8)
    }
      .onClick("@actions.increment")
      .margin(4)
  }
}
  .padding(24)
  .backgroundColor("#f5f5f5")
  .width("100%")
  .height("100%")`,
    logic: `import { app } from "@hypen-space/core";

type CounterState = {
  count: number;
};

export default app
  .defineState<CounterState>({ count: 0 })
  .onCreated(async (state) => {
    console.log("Counter initialized");
  })
  .onAction("increment", async (action, state) => {
    state.count++;
    console.log("Count incremented:", state.count);
  })
  .onAction("decrement", async (action, state) => {
    state.count--;
    console.log("Count decremented:", state.count);
  })
  .onAction("reset", async (action, state) => {
    state.count = 0;  
    console.log("Count reset:", state.count);
  })
  .build();`
  },
  profile: {
    name: "Profile Page",
    hypen: `Column {
  Text("Welcome, @{state.user?.name ?? 'Guest'}")
    .fontSize(28)
    .fontWeight("bold")
    .margin(16)

  Text("@{state.user ? 'Premium User' : 'Sign in to continue'}")
    .fontSize(14)
    .color("#666")
    .margin(8)

  Button {
    Text("Sign in with Google")
      .padding(12)
      .color("white")
  }
    .onClick("@actions.signInWithGoogle")
    .backgroundColor("#4285f4")
    .borderRadius(4)
    .margin(16)
}
  .padding(24)
  .backgroundColor("#ffffff")`,
    logic: `import { app } from "@hypen-space/core";

type User = {
  id: string;
  name: string;
  premium: boolean;
};

type ProfileState = {
  user: User | null;
};

export default app
  .defineState<ProfileState>({ user: null })
  .onCreated(async (state) => {
    console.log("ProfilePage created");
  })
  .onAction("signInWithGoogle", async (action, state) => {
    // Simulate Google sign-in
    state.user = {
      id: "1",
      name: "Ada Lovelace",
      premium: true,
    };
  })
  .build();`
  },
  todo: {
    name: "Todo List",
    hypen: `Column {
  Text("My Tasks")
    .fontSize(24)
    .fontWeight("bold")
    .margin(16)

  Row {
    Input("@state.newTask")
      .placeholder("Add a new task... (press Enter)")
      .width("300px")
      .padding(8)
      .margin(4)
      .onInput("@actions.updateNewTask")
      .onKey("@actions.addTask")

    Button {
      Text("Add")
        .padding(8)
    }
      .onClick("@actions.addTask")
      .backgroundColor("#4caf50")
      .color("white")
      .margin(4)
  }

  Column {
    Text("@{state.tasks.length} tasks")
      .fontSize(12)
      .color("#999")
      .margin(8)
    
    List(@state.tasks) {
      Text("• @{item.text}")
        .margin(4)
        .fontSize(14)
    }
  }
}
  .padding(24)
  .backgroundColor("#fafafa")`,
    logic: `import { app } from "@hypen-space/core";

type TodoState = {
  tasks: Array<{ id: string; text: string; done: boolean }>;
  newTask: string;
};

export default app
  .defineState<TodoState>({
    tasks: [],
    newTask: "",
  })
  .onCreated(async (state) => {
    state.tasks = [
      { id: "1", text: "Learn Hypen", done: false },
      { id: "2", text: "Build an app", done: false },
    ];
  })
  .onAction("updateNewTask", async (action, state) => {
    // Update newTask from input event
    state.newTask = action.payload?.input || action.payload?.value || "";
    console.log("New task input:", state.newTask);
  })
  .onAction("addTask", async (action, state) => {
    if (state.newTask.trim()) {
      state.tasks.push({
        id: Date.now().toString(),
        text: state.newTask,
        done: false,
      });
      state.newTask = "";
      console.log("Task added! Total tasks:", state.tasks.length);
    }
  })
  .build();`
  },
  form: {
    name: "Form Example",
    hypen: `Column {
  Text("Contact Form")
    .fontSize(24)
    .fontWeight("bold")
    .margin(16)

  Column {
    Text("Name")
      .fontSize(14)
      .margin(4)

    Input("@state.name")
      .placeholder("Enter your name")
      .width("100%")
      .padding(8)
      .margin(4)

    Text("Email")
      .fontSize(14)
      .margin(4)

    Input("@state.email")
      .placeholder("Enter your email")
      .type("email")
      .width("100%")
      .padding(8)
      .margin(4)

    Button {
      Text("Submit")
        .padding(12)
        .color("white")
    }
      .onClick("@actions.submit")
      .backgroundColor("#2196f3")
      .borderRadius(4)
      .margin(16)
  }
    .width("400px")
}
  .padding(24)`,
    logic: `import { app } from "@hypen-space/core";

type FormState = {
  name: string;
  email: string;
  submitted: boolean;
};

export default app
  .defineState<FormState>({
    name: "",
    email: "",
    submitted: false,
  })
  .onAction("submit", async (action, state) => {
    console.log("Submitting form:", {
      name: state.name,
      email: state.email,
    });

    state.submitted = true;

    // Reset after 2 seconds
    setTimeout(() => {
      state.submitted = false;
    }, 2000);
  })
  .build();`
  }
};

// playground/playground.ts
console.log("\uD83D\uDCDA Available samples:", Object.keys(samples));
var hypenEditor;
var logicEditor;
var renderer = null;
var engine = null;
var currentModule = null;
var currentState = null;
var isLoadingSample = false;
function convertMapsToObjects(value) {
  if (value instanceof Map) {
    if (value.size === 0) {
      return {};
    }
    const entries = Array.from(value.entries());
    const values = Array.from(value.values());
    const firstEntry = values[0];
    if (firstEntry instanceof Map) {
      const plainObj = {};
      for (const entry of values) {
        if (entry instanceof Map) {
          for (const [key, val] of entry.entries()) {
            plainObj[key] = convertMapsToObjects(val);
          }
        }
      }
      return plainObj;
    } else {
      const obj = {};
      for (const [key, val] of entries) {
        obj[key] = convertMapsToObjects(val);
      }
      return obj;
    }
  } else if (Array.isArray(value)) {
    return value.map((item) => convertMapsToObjects(item));
  } else if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof RegExp)) {
    const obj = {};
    for (const [key, val] of Object.entries(value)) {
      obj[key] = convertMapsToObjects(val);
    }
    return obj;
  }
  return value;
}
function initEditors() {
  const amdRequire = window.require;
  amdRequire.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs" } });
  amdRequire(["vs/editor/editor.main"], () => {
    const commonOptions = {
      theme: "vs-dark",
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: "on",
      scrollBeyondLastLine: false,
      automaticLayout: true
    };
    hypenEditor = monaco.editor.create(document.getElementById("hypen-editor"), {
      ...commonOptions,
      language: "javascript",
      value: samples.counter.hypen
    });
    logicEditor = monaco.editor.create(document.getElementById("logic-editor"), {
      ...commonOptions,
      language: "typescript",
      value: samples.counter.logic
    });
    let debounceTimer = null;
    const triggerUpdate = () => {
      if (isLoadingSample) {
        console.log("⏭️ Skipping auto-render during sample load");
        return;
      }
      if (debounceTimer)
        clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        renderPreview();
      }, 500);
    };
    hypenEditor.onDidChangeModelContent(triggerUpdate);
    logicEditor.onDidChangeModelContent(triggerUpdate);
    console.log("\uD83D\uDE80 Starting initial render...");
    setTimeout(() => {
      console.log("⏰ Initial render timeout triggered");
      renderPreview(true);
    }, 100);
  });
}
function loadSample(sampleKey) {
  console.log("\uD83D\uDCE5 Loading sample:", sampleKey);
  const sample = samples[sampleKey];
  if (!sample) {
    console.error("❌ Sample not found:", sampleKey);
    return;
  }
  console.log("\uD83D\uDCDD Sample found:", sample.name);
  isLoadingSample = true;
  if (hypenEditor) {
    console.log("✏️ Setting Hypen code");
    hypenEditor.setValue(sample.hypen);
  }
  if (logicEditor) {
    console.log("✏️ Setting logic code");
    logicEditor.setValue(sample.logic);
  }
  console.log("\uD83D\uDD04 Triggering full rebuild...");
  renderPreview(true);
  isLoadingSample = false;
}
async function renderPreview(forceFullRebuild = false) {
  console.log("\uD83C\uDFAC Starting renderPreview...", forceFullRebuild ? "(full rebuild)" : "(incremental)");
  const hypenCode = hypenEditor?.getValue() || "";
  const logicCode = logicEditor?.getValue() || "";
  const previewEl = document.getElementById("preview");
  const errorBanner = document.getElementById("error-banner");
  console.log("\uD83D\uDCDD Hypen code length:", hypenCode.length);
  console.log("\uD83D\uDCDD Logic code length:", logicCode.length);
  errorBanner.textContent = "";
  errorBanner.classList.remove("show");
  if (forceFullRebuild) {
    console.log("\uD83E\uDDF9 Full rebuild: clearing DOM, renderer, engine, and state");
    console.log("\uD83E\uDDF9 Previous currentState:", currentState);
    console.log("\uD83E\uDDF9 Previous currentModule:", currentModule?.name);
    console.log("\uD83E\uDDF9 Preview DOM children before clear:", previewEl.children.length);
    previewEl.innerHTML = "";
    console.log("\uD83E\uDDF9 Preview DOM children after innerHTML clear:", previewEl.children.length);
    if (renderer) {
      console.log("\uD83E\uDDF9 Clearing renderer node registry...");
      renderer.clear();
    }
    if (engine) {
      console.log("\uD83E\uDDF9 Clearing engine tree...");
      engine.clearTree();
    }
    currentModule = null;
    currentState = null;
    console.log("\uD83E\uDDF9 Cleared currentState:", currentState);
    console.log("\uD83E\uDDF9 Final preview DOM children:", previewEl.children.length);
  }
  try {
    if (!engine) {
      engine = new Engine;
      await engine.init();
    }
    if (!renderer) {
      renderer = new DOMRenderer(previewEl, engine);
      engine.setRenderCallback((patches) => {
        console.log("\uD83D\uDD27 Received patches:", patches.length);
        console.log("\uD83D\uDCCB Patch types:", patches.map((p) => p.type));
        const rootInserts = patches.filter((p) => p.type === "insert" && p.parent_id === "root");
        console.log("\uD83C\uDF33 Root inserts:", rootInserts.length);
        renderer.applyPatches(patches);
        const fallbackState = currentModule?.initialState || {};
        renderer.updateState(currentState || fallbackState);
        if (rootInserts.length === 0 && patches.length > 0) {
          console.log("\uD83D\uDD27 No root inserts found, looking for first create...");
          const firstCreate = patches.find((p) => p.type === "create");
          if (firstCreate?.id) {
            console.log("\uD83D\uDD27 Found first create:", firstCreate.id);
            const rootNode = renderer.getNode(firstCreate.id);
            if (rootNode && !rootNode.parentElement) {
              console.log("\uD83D\uDD27 Manually inserting root node");
              previewEl.appendChild(rootNode);
            }
          }
        }
      });
    }
    const jsCode = ts.transpileModule(logicCode, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
        removeComments: true
      }
    }).outputText;
    const moduleCode = jsCode.replace(/import\s+.*?from\s+['"].*?['"];?\s*/g, "").replace(/export default/, "return");
    const createModule = new Function("app", moduleCode);
    const moduleDef = createModule(app);
    const moduleName = moduleDef.name || "main";
    engine.setModule(moduleName, moduleDef.actions, moduleDef.stateKeys, convertMapsToObjects(moduleDef.initialState));
    console.log("\uD83D\uDD27 Creating observable state. currentState:", currentState);
    console.log("\uD83D\uDD27 Module initial state:", moduleDef.initialState);
    const initialStateToUse = convertMapsToObjects(currentState || moduleDef.initialState);
    console.log("\uD83D\uDD27 Using initial state:", initialStateToUse);
    const observableState = createObservableState(initialStateToUse, {
      onChange: (change) => {
        const snapshot = convertMapsToObjects(getStateSnapshot(observableState));
        console.log(`\uD83D\uDCF8 [Observable onChange] State snapshot:`, snapshot, `Changes:`, change.paths);
        if (snapshot.tasks && Array.isArray(snapshot.tasks)) {
          console.log(`\uD83D\uDCF8 [Observable onChange] First task:`, snapshot.tasks[0]);
          console.log(`\uD83D\uDCF8 [Observable onChange] First task type:`, snapshot.tasks[0]?.constructor?.name);
        }
        currentState = snapshot;
        engine.updateState(snapshot);
      }
    });
    if (moduleDef.handlers?.onAction) {
      for (const [actionName, handler] of moduleDef.handlers.onAction) {
        engine.onAction(actionName, async (action) => {
          console.log(`\uD83C\uDFAF [Action ${actionName}] Received action:`, action);
          let payload = action.payload;
          console.log(`\uD83D\uDD0D [Action ${actionName}] Raw payload type:`, payload?.constructor?.name, "Size:", payload instanceof Map ? payload.size : "N/A");
          if (payload instanceof Map) {
            console.log(`\uD83D\uDD0D [Action ${actionName}] Map entries:`, Array.from(payload.entries()));
            console.log(`\uD83D\uDD0D [Action ${actionName}] Map values:`, Array.from(payload.values()));
            payload = convertMapsToObjects(payload);
            console.log(`\uD83D\uDD04 [Action ${actionName}] Converted payload to plain object:`, payload);
          }
          await handler({ ...action, payload }, observableState);
          const snapshot = convertMapsToObjects(getStateSnapshot(observableState));
          console.log(`\uD83D\uDCF8 [Action ${actionName}] State snapshot after handler:`, snapshot);
          currentState = snapshot;
          engine.updateState(snapshot);
        });
      }
    }
    currentModule = moduleDef;
    try {
      const debugResult = engine.debugParseComponent(`Button { Text("Test") }.onClick("@actions.test")`);
      console.log("\uD83D\uDD0D Debug parse result:", debugResult);
    } catch (e) {
      console.log("\uD83D\uDD0D Debug parse failed:", e);
    }
    console.log("\uD83C\uDFA8 Rendering Hypen code:", hypenCode.substring(0, 100) + "...");
    engine.renderSource(hypenCode);
    if (moduleDef.handlers?.onCreated) {
      console.log("\uD83C\uDF31 Calling onCreated lifecycle...");
      await moduleDef.handlers.onCreated(observableState);
      console.log("✅ onCreated completed, state:", getStateSnapshot(observableState));
    }
    const currentStateSnapshot = convertMapsToObjects(getStateSnapshot(observableState));
    console.log("\uD83D\uDCCA Updating state:", currentStateSnapshot);
    console.log("\uD83D\uDCCA State tasks type:", currentStateSnapshot.tasks?.constructor?.name);
    if (Array.isArray(currentStateSnapshot.tasks)) {
      console.log("\uD83D\uDCCA First task:", currentStateSnapshot.tasks[0]);
      console.log("\uD83D\uDCCA First task type:", currentStateSnapshot.tasks[0]?.constructor?.name);
    }
    engine.updateState(currentStateSnapshot);
  } catch (error) {
    console.error("Playground error:", error);
    errorBanner.textContent = `Error: ${error.message || String(error)}`;
    errorBanner.classList.add("show");
  }
}
function setupSampleSelector() {
  const selector = document.getElementById("sample-selector");
  selector.addEventListener("change", (e) => {
    const target = e.target;
    const sampleKey = target.value;
    if (sampleKey) {
      loadSample(sampleKey);
    }
  });
}
function setupDebugControls() {
  const debugToggle = document.getElementById("debug-toggle");
  const resetButton = document.getElementById("reset-debug");
  debugToggle.addEventListener("change", () => {
    if (renderer) {
      renderer.setDebugConfig({
        enabled: debugToggle.checked,
        showHeatmap: true,
        heatmapIncrement: 5,
        fadeOutDuration: 2000
      });
      console.log(`\uD83D\uDC1B Debug mode ${debugToggle.checked ? "enabled" : "disabled"}`);
      if (debugToggle.checked) {
        const stats = renderer.getDebugStats();
        console.log(`\uD83D\uDCCA Debug stats:`, stats);
      }
    }
  });
  resetButton.addEventListener("click", () => {
    if (renderer) {
      renderer.resetDebugTracking();
      console.log("\uD83E\uDDF9 Debug tracking reset");
    }
  });
}
window.addEventListener("DOMContentLoaded", () => {
  initEditors();
  setupSampleSelector();
  setupDebugControls();
});
