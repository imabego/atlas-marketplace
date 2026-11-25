const $ = (s) => document.querySelector(s);
let me = null, products = [], cart = [], currentOrder = null, currentPayment = null;
const money = n => new Intl.NumberFormat("fr-FR",{style:"currency",currency:"EUR"}).format(n);
async function api(url, options={}) {
  const response = await fetch(url,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})},credentials:"same-origin"});
  const data = await response.json().catch(()=>({message:"Réponse serveur invalide."}));
  if(!response.ok) throw new Error(data.message || "Une erreur est survenue.");
  return data;
}
function esc(s=""){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function refreshMe(){const d=await api("/api/me");me=d.user;$("#accountBtn").textContent=me?`Salut, ${me.name.split(" ")[0]}`:"Connexion";}
async function loadProducts(){
  const q=$("#search").value.trim(); const d=await api("/api/products?q="+encodeURIComponent(q));products=d.products;
  $("#products").innerHTML=products.length?products.map(p=>`<article class="product"><img src="${esc(p.image||"https://placehold.co/800x600?text=ATLAS")}" alt="${esc(p.name)}" onerror="this.src='https://placehold.co/800x600?text=ATLAS'"><div class="product-info"><small>${esc(p.category||"AUTRES")} · ${p.stock} en stock</small><h3>${esc(p.name)}</h3><p>${esc(p.description||"Découvre ce produit sur ATLAS.")}</p><div class="product-bottom"><strong>${money(p.price)}</strong><button onclick="addToCart('${p.id}')" ${p.stock<1?"disabled":""}>Ajouter +</button></div></div></article>`).join(""):"<p class='empty'>Aucun produit trouvé pour le moment.</p>";
}
function addToCart(id){const p=products.find(x=>x.id===id);if(!p)return;const line=cart.find(x=>x.id===id);if(line)line.quantity++;else cart.push({id,quantity:1});updateCart();}
function updateCart(){
  $("#cartCount").textContent=cart.reduce((s,x)=>s+x.quantity,0);
  const lines=cart.map(x=>{const p=products.find(y=>y.id===x.id);return p?`<div class="cart-line"><span>${esc(p.name)} × ${x.quantity}</span><b>${money(p.price*x.quantity)}</b><button onclick="removeCart('${p.id}')">Retirer</button></div>`:"";}).join("");
  $("#cartItems").innerHTML=lines||"<p>Ton panier est vide.</p>";
  $("#cartTotal").textContent=money(cart.reduce((s,x)=>{const p=products.find(y=>y.id===x.id);return s+(p?p.price*x.quantity:0)},0));
}
function removeCart(id){cart=cart.filter(x=>x.id!==id);updateCart();}
function openAuth(){ $("#authDialog").showModal(); }
let registerMode=false;
function setAuthMode(){registerMode=!registerMode;$("#authTitle").textContent=registerMode?"Créer un compte":"Connexion";$("#nameWrap").hidden=!registerMode;$("#authSubmit").textContent=registerMode?"Créer mon compte":"Se connecter";$("#toggleAuth").textContent=registerMode?"J'ai déjà un compte":"Créer un compte";$("#authPassword").autocomplete=registerMode?"new-password":"current-password";}
async function authSubmit(){
  const payload={name:$("#authName").value,email:$("#authEmail").value,password:$("#authPassword").value};
  try{const d=await api(registerMode?"/api/register":"/api/login",{method:"POST",body:JSON.stringify(payload)});me=d.user;$("#authDialog").close();$("#accountBtn").textContent=`Salut, ${me.name.split(" ")[0]}`;alert("Bienvenue sur ATLAS !");}
  catch(e){$("#authMessage").textContent=e.message;}
}
async function loadOrders(){
  try{const d=await api("/api/orders");$("#ordersList").innerHTML=d.orders.length?d.orders.map(o=>`<div class="order-card"><div><strong>Commande du ${new Date(o.createdAt).toLocaleDateString("fr-FR")}</strong><small>${esc(o.status)}</small></div><b>${money(o.total)}</b></div>`).join(""):"Tu n'as pas encore de commande.";}
  catch(e){$("#ordersList").textContent=e.message;}
}
async function sellerPanel(){
  if(!me){openAuth();return;}
  try{
    if(!me.isSeller){const d=await api("/api/seller/activate",{method:"POST",body:"{}"});me=d.user;}
    const d=await api("/api/seller/products");
    $("#sellerContent").innerHTML=`<p class="message success">Ton espace vendeur est activé. Les produits publiés sont visibles dans la boutique.</p>
    <div class="seller-form"><h3>Ajouter un produit</h3><label>Nom<input id="pName" maxlength="100" required></label><label>Prix (€)<input id="pPrice" type="number" min="0.01" step="0.01" required></label><label>Stock<input id="pStock" type="number" min="0" step="1" value="1" required></label><label>Catégorie<input id="pCategory" placeholder="Ex. Maison"></label><label>Description<textarea id="pDescription" maxlength="1000"></textarea></label><label>Image (URL https://)<input id="pImage" type="url" placeholder="https://..."></label><button class="primary full" type="button" id="saveProduct">Publier le produit</button><p id="sellerMessage" class="message"></p></div><div class="seller-products"><h3>Mes produits (${d.products.length})</h3><div id="myProducts">${d.products.map(p=>`<div class="seller-product"><span>${esc(p.name)} · ${money(p.price)} · stock ${p.stock}</span><button onclick="deleteProduct('${p.id}')">Supprimer</button></div>`).join("")||"Tu n'as pas encore publié de produit."}</div></div>`;
    $("#saveProduct").addEventListener("click",saveProduct);
    $("#sellerDialog").showModal();
  }catch(e){alert(e.message);}
}
async function saveProduct(){
  const body={name:$("#pName").value,price:$("#pPrice").value,stock:$("#pStock").value,category:$("#pCategory").value,description:$("#pDescription").value,image:$("#pImage").value};
  try{await api("/api/seller/products",{method:"POST",body:JSON.stringify(body)});$("#sellerMessage").textContent="Produit publié avec succès !";await loadProducts();await sellerPanelRefresh();}
  catch(e){$("#sellerMessage").textContent=e.message;}
}
async function sellerPanelRefresh(){
  const d=await api("/api/seller/products");
  $("#myProducts").innerHTML=d.products.map(p=>`<div class="seller-product"><span>${esc(p.name)} · ${money(p.price)} · stock ${p.stock}</span><button onclick="deleteProduct('${p.id}')">Supprimer</button></div>`).join("")||"Tu n'as pas encore publié de produit.";
}
async function deleteProduct(id){if(!confirm("Supprimer ce produit ?"))return;try{await api("/api/seller/products/"+id,{method:"DELETE"});await loadProducts();await sellerPanelRefresh();}catch(e){alert(e.message);}}

async function checkout(){
  try{
    if(!me){$("#cartDialog").close();openAuth();return;}
    if(!cart.length){$("#checkoutMessage").textContent="Ton panier est vide.";return;}
    const d=await api("/api/orders",{method:"POST",body:JSON.stringify({items:cart})});
    currentOrder=d.order; cart=[]; updateCart(); $("#cartDialog").close();
    $("#paymentOrderTotal").textContent=money(currentOrder.total);
    $("#paymentMessage").textContent=d.message;
    $("#paymentStart").hidden=false; $("#paymentSimulate").hidden=true;
    $("#paymentDialog").showModal(); await loadProducts(); await loadOrders();
  } catch(e){$("#checkoutMessage").textContent=e.message;}
}
async function startPayment(){
  if(!currentOrder)return;
  try{
    const method=$("#paymentMethod").value;
    const d=await api("/api/payments",{method:"POST",body:JSON.stringify({orderId:currentOrder.id,method})});
    currentPayment=d.payment;
    $("#paymentReference").textContent=currentPayment.reference;
    $("#paymentMessage").textContent=d.message;
    $("#paymentStart").hidden=true; $("#paymentSimulate").hidden=false;
  }catch(e){$("#paymentMessage").textContent=e.message;}
}
async function simulatePayment(){
  if(!currentPayment)return;
  try{
    const d=await api(`/api/payments/${currentPayment.id}/simulate-success`,{method:"POST",body:"{}"});
    $("#paymentMessage").textContent=d.message;
    $("#paymentSimulate").hidden=true;
    $("#paymentStatus").textContent="PAYÉE — SIMULATION";
    await loadOrders();
  }catch(e){$("#paymentMessage").textContent=e.message;}
}
$("#accountBtn").addEventListener("click",async()=>{if(me){if(confirm("Se déconnecter de ATLAS ?")){await api("/api/logout",{method:"POST",body:"{}"});me=null;await refreshMe();}}else openAuth();});
$("#authSubmit").addEventListener("click",authSubmit);$("#toggleAuth").addEventListener("click",setAuthMode);
$("#cartBtn").addEventListener("click",()=>{$("#cartDialog").showModal();updateCart();});
$("#sellerBtn").addEventListener("click",sellerPanel);$("#checkoutBtn").addEventListener("click",checkout);$("#loadOrders").addEventListener("click",loadOrders);
$("#paymentStart").addEventListener("click",startPayment);$("#paymentSimulate").addEventListener("click",simulatePayment);
$("#search").addEventListener("input",()=>loadProducts().catch(e=>$("#products").textContent=e.message));
document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>$("#"+b.dataset.close).close()));
document.querySelectorAll(".close").forEach(b=>b.addEventListener("click",()=>b.closest("dialog").close()));
(async()=>{try{await refreshMe();await loadProducts();}catch(e){$("#products").textContent=e.message;}})();
