/* DOM-only helpers kept after application modules initialize. */

/* Extracted from index.html: stable-overflow-menu-fix */
(() => {
  const init = () => {
    const details = document.getElementById('moreMenu');
    const summary = details && details.querySelector('button[aria-label="More options"]');
    const pop = details && details.querySelector('.menu-pop');
    if (!details || !summary || !pop || details.dataset.menuFix === '3') return;
    details.dataset.menuFix = '3';

    // Portal the menu to body so card/header stacking contexts cannot cover it.
    document.body.appendChild(pop);
    Object.assign(pop.style, {
      position: 'fixed', inset: 'auto', margin: '0',
      zIndex: '2147483647', display: 'none',
      maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 24px)',
      overflowY: 'auto', overscrollBehavior: 'contain'
    });

    const isOpen = () => pop.style.display !== 'none';
    const place = () => {
      if (!isOpen()) return;
      const r = summary.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      const offsetTop = window.visualViewport ? window.visualViewport.offsetTop : 0;
      const margin = 12;
      const width = Math.min(260, vw - margin * 2);
      pop.style.width = width + 'px';
      pop.style.maxHeight = Math.max(120, vh - margin * 2) + 'px';
      const height = Math.min(pop.scrollHeight, vh - margin * 2);
      const left = Math.max(margin, Math.min(r.right - width, vw - width - margin));
      let top = r.bottom + 8;
      if (top + height > vh - margin) top = r.top - height - 8;
      top = Math.max(margin, Math.min(top, vh - height - margin));
      pop.style.left = left + 'px';
      pop.style.top = (top + offsetTop) + 'px';
    };
    let positionFrame = 0;
    const reposition = () => {
      if (!isOpen() || positionFrame) return;
      positionFrame = requestAnimationFrame(() => {
        positionFrame = 0;
        if (isOpen()) place();
      });
    };
    const startPositionTracking = () => {
      window.addEventListener('resize', reposition, {passive:true});
      window.addEventListener('scroll', reposition, {passive:true, capture:true});
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', reposition, {passive:true});
        window.visualViewport.addEventListener('scroll', reposition, {passive:true});
      }
    };
    const stopPositionTracking = () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', reposition);
        window.visualViewport.removeEventListener('scroll', reposition);
      }
      if (positionFrame) {
        cancelAnimationFrame(positionFrame);
        positionFrame = 0;
      }
    };
    const close = () => {
      stopPositionTracking();
      pop.style.display = 'none';
      details.open = false;
      summary.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      details.open = true;
      pop.style.display = 'block';
      summary.setAttribute('aria-expanded', 'true');
      place();
      startPositionTracking();
      reposition();
    };

    summary.setAttribute('aria-haspopup', 'true');
    summary.setAttribute('aria-expanded', 'false');
    summary.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      isOpen() ? close() : open();
    });
    pop.addEventListener('click', event => {
      event.stopPropagation();
      if (event.target.closest('button, label')) close();
    });
    document.addEventListener('click', event => {
      if (isOpen() && !pop.contains(event.target) && !summary.contains(event.target)) close();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && isOpen()) {
        close();
        summary.focus();
      }
    });

  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();

/* Extracted from index.html: curriculumRequestFormLink */
(()=> {
  'use strict';
  // This is the public responder link, not the owner's edit link.
  // Public responder URL for curriculum suggestions.
  const CURRICULUM_REQUEST_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSemYy3Kme4IlSCGPEbudvzYV7K-BRefBbIzQLNVx5cdmWkt0Q/viewform';
  const boot=()=>{
    const explore=document.querySelector('#view-explore');
    if(!explore || document.querySelector('#curriculumRequestCard')) return;
    const hero=explore.querySelector('.explore-hero');
    if(!hero) return;
    const card=document.createElement('section');
    card.id='curriculumRequestCard';
    card.className='curriculum-request-card';
    card.innerHTML='<div><span class="explore-eyebrow">HELP EXPAND NEXUS</span><h3>Can’t find your curriculum?</h3><p>Suggest a subject, course, or exam syllabus for future inclusion. Requests are reviewed manually, and submitting a suggestion does not guarantee that it will be added.</p></div><div class="curriculum-request-actions"><a class="btn btn-primary curriculum-request-link" id="openCurriculumRequestForm" href="#" aria-disabled="true"><span>Suggest a curriculum</span><span class="curriculum-request-arrow" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none"><path d="M5.5 14.5 14 6M6.5 6H14v7.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span></a></div>';
    const link=card.querySelector('#openCurriculumRequestForm');
    if(CURRICULUM_REQUEST_FORM_URL){
      link.href=CURRICULUM_REQUEST_FORM_URL;
      link.target='_blank';
      link.rel='noopener noreferrer';
      link.removeAttribute('aria-disabled');
    }else{
      link.title='The request form link has not been connected yet.';
      link.addEventListener('click',event=>{
        event.preventDefault();
        alert('The Google Form link has not been connected yet. This will be enabled before the updated version is released.');
      });
    }
    hero.insertAdjacentElement('afterend',card);
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();

/* Extracted from index.html: nexus-mobile-parent-scroll-gesture */
(() => {
  'use strict';

  // Detect the real scroll container instead of relying on a list of class names.
  // A two-finger gesture beginning in an inner scroller should move the document;
  // a one-finger gesture remains under the browser's native scroll handling.
  let active = false;
  let previousY = 0;
  const pageScrollClass = 'nexus-touch-page-scroll';

  const style = document.createElement('style');
  style.textContent = 'html.nexus-touch-page-scroll{scroll-behavior:auto!important}';
  document.head.appendChild(style);

  const centerY = touches => {
    let total = 0;
    for (let i = 0; i < touches.length; i++) total += touches[i].clientY;
    return total / touches.length;
  };

  const scrollableAncestor = target => {
    for (let el = target && target.nodeType === 3 ? target.parentElement : target;
         el && el !== document.body && el !== document.documentElement;
         el = el.parentElement) {
      const overflowY = window.getComputedStyle(el).overflowY;
      if (/^(auto|scroll|overlay)$/.test(overflowY) && el.scrollHeight > el.clientHeight + 1) {
        return el;
      }
    }
    return null;
  };

  const touchesScrollableBox = touches => {
    for (let i = 0; i < touches.length; i++) {
      if (scrollableAncestor(touches[i].target)) return true;
    }
    return false;
  };

  document.addEventListener('touchstart', event => {
    active = false;
    if (event.touches.length < 2 || !touchesScrollableBox(event.touches)) {
      document.documentElement.classList.remove(pageScrollClass);
      return;
    }

    active = true;
    previousY = centerY(event.touches);
    document.documentElement.classList.add(pageScrollClass);

    // Cancel the inner scroller's native gesture before it takes ownership.
    if (event.cancelable) event.preventDefault();
  }, { capture: true, passive: false });

  document.addEventListener('touchmove', event => {
    if (!active || event.touches.length < 2) return;
    if (event.cancelable) event.preventDefault();

    const nextY = centerY(event.touches);
    const scrollingElement = document.scrollingElement || document.documentElement;
    scrollingElement.scrollTop += previousY - nextY;
    previousY = nextY;
  }, { capture: true, passive: false });

  const reset = event => {
    if (!event.touches || event.touches.length < 2) {
      active = false;
      document.documentElement.classList.remove(pageScrollClass);
    }
  };
  document.addEventListener('touchend', reset, { capture: true, passive: true });
  document.addEventListener('touchcancel', reset, { capture: true, passive: true });
})();
